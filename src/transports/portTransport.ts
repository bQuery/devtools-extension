/**
 * Optional transport: a long-lived port to the background router.
 *
 * This is the push-based path — the page's timeline events reach the panel as
 * they happen instead of on the next poll. It costs one host permission for
 * the inspected origin (requested from the panel, on a user gesture) plus an
 * on-demand content-script injection, so it is opt-in per site.
 *
 * The port is expected to die: MV3 service workers are evicted aggressively.
 * A disconnect therefore reconnects with backoff and re-runs `attach`, and the
 * client above re-runs the bridge handshake on the fresh route.
 *
 * @module transports/portTransport
 */
import { extensionApi } from '../browser';
import { ENVELOPE_SOURCE, PANEL_PORT_NAME, parseBackgroundEnvelope } from '../protocol/envelope';
import type { InboundMessage } from '../protocol/messages';
import type { BridgeTransport, TransportHandlers } from '../protocol/transport';

/** The slice of `chrome.runtime.Port` the panel uses. */
export interface PanelPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}

/** Options for {@link PortTransport}. */
export interface PortTransportOptions {
  /** Tab id of the inspected window. */
  readonly tabId: number;
  /** Opens a port to the background worker. Injected for tests. */
  readonly connect?: () => PanelPort;
  /** Reconnect backoff, in ms. @default [250, 500, 1000, 2000, 5000] */
  readonly backoffMs?: readonly number[];
  /** Injectable timer, so tests do not wait in real time. */
  readonly setTimeout?: (handler: () => void, ms: number) => number;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;

/** Push transport over `chrome.runtime.connect`. */
export class PortTransport implements BridgeTransport {
  public readonly kind = 'port' as const;

  private readonly tabId: number;
  private readonly connectPort: () => PanelPort;
  private readonly backoffMs: readonly number[];
  private readonly setTimer: (handler: () => void, ms: number) => number;

  private handlers: TransportHandlers | null = null;
  private port: PanelPort | null = null;
  private token: string | null = null;
  private queued: InboundMessage[] = [];
  private attempt = 0;
  private disposed = false;

  constructor(options: PortTransportOptions) {
    this.tabId = options.tabId;
    this.connectPort =
      options.connect ??
      (() => extensionApi().runtime.connect({ name: PANEL_PORT_NAME }) as unknown as PanelPort);
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.setTimer =
      options.setTimeout ??
      ((handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number);
  }

  public start(handlers: TransportHandlers): void {
    if (this.disposed || this.handlers) return;
    this.handlers = handlers;
    this.open();
  }

  public send(message: InboundMessage): void {
    if (this.disposed) return;
    if (!this.port || !this.token) {
      // Not attached yet — hold the frame until the route is open.
      this.queued.push(message);
      if (this.queued.length > 32) this.queued.shift();
      return;
    }
    this.port.postMessage({
      source: ENVELOPE_SOURCE,
      type: 'to-page',
      token: this.token,
      payload: message,
    });
  }

  /**
   * Ask the background worker to (re)inject the content script.
   *
   * Resolves with the router's verdict; a rejection means the route never
   * opened (no permission, restricted page, …).
   */
  public requestInjection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.token) {
        reject(new Error('bQuery DevTools: not attached to the inspected tab'));
        return;
      }
      this.injectionWaiters.push({ resolve, reject });
      this.port.postMessage({ source: ENVELOPE_SOURCE, type: 'inject', token: this.token });
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleInjection(new Error('bQuery DevTools: transport disposed'));
    this.port?.disconnect();
    this.port = null;
    this.token = null;
    this.handlers = null;
  }

  private readonly injectionWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  private open(): void {
    if (this.disposed || !this.handlers) return;
    this.handlers.onStatus({ kind: 'connecting' });

    let port: PanelPort;
    try {
      port = this.connectPort();
    } catch (error) {
      this.handlers.onStatus({
        kind: 'error',
        reason: error instanceof Error ? error.message : 'cannot reach the background worker',
      });
      return;
    }

    this.port = port;
    this.token = null;

    port.onMessage.addListener((message: unknown) => this.handlePortMessage(message));
    port.onDisconnect.addListener(() => this.handleDisconnect());

    port.postMessage({ source: ENVELOPE_SOURCE, type: 'attach', tabId: this.tabId });
  }

  private handlePortMessage(message: unknown): void {
    if (this.disposed || !this.handlers) return;
    const envelope = parseBackgroundEnvelope(message);
    if (!envelope) return;

    switch (envelope.type) {
      case 'attached': {
        this.token = envelope.token;
        this.attempt = 0;
        this.handlers.onStatus({ kind: 'open' });
        const queued = this.queued;
        this.queued = [];
        for (const pending of queued) this.send(pending);
        return;
      }
      case 'attach-failed':
        this.handlers.onStatus({ kind: 'error', reason: envelope.reason });
        return;
      case 'inject-result':
        if (envelope.ok) this.settleInjection(null);
        else this.settleInjection(new Error(envelope.reason ?? 'injection failed'));
        return;
      case 'from-page':
        this.handlers.onMessage(envelope.payload);
        return;
    }
  }

  private handleDisconnect(): void {
    if (this.disposed || !this.handlers) return;
    this.port = null;
    this.token = null;
    this.settleInjection(new Error('bQuery DevTools: background worker disconnected'));
    this.handlers.onStatus({ kind: 'closed', reason: 'background worker disconnected' });

    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)] ?? 1000;
    this.attempt += 1;
    this.setTimer(() => this.open(), delay);
  }

  private settleInjection(error: Error | null): void {
    const waiters = this.injectionWaiters.splice(0, this.injectionWaiters.length);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}
