/**
 * Typed bridge client — the panel's half of the v1 protocol.
 *
 * Responsibilities:
 *  - handshake: send `hello`, retry until the page answers `init`
 *    (the panel is routinely open *before* the app boots);
 *  - capability negotiation from the `init` payload;
 *  - request/response correlation with per-request timeouts, so a page that
 *    never answers cannot leak pending promises forever;
 *  - reconnection: a dropped transport (service-worker sleep, navigation)
 *    restarts the handshake with backoff and rejects everything in flight.
 *
 * @module protocol/client
 */
import { signal, type Signal } from '@bquery/bquery/reactive';
import {
  BRIDGE_PROTOCOL_VERSION,
  foreignProtocolVersion,
  helloMessage,
  negotiateCapabilities,
  parseOutbound,
  requestMessage,
  type BridgeCapability,
  type BridgeMethodName,
  type TimelineEntry,
} from './messages';
import type { BridgeTransport, TransportStatus } from './transport';

/**
 * Connection state as displayed by the panel.
 *
 * `incompatible` is its own state rather than an error: the page *is*
 * answering, it simply speaks a bridge protocol this panel does not. The
 * distinction is what the status bar needs to tell the user to update the
 * extension instead of debugging their app.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'waiting-for-page'
  | 'connected'
  | 'incompatible'
  | 'disconnected'
  | 'error';

/** Options for {@link BridgeClient}. */
export interface BridgeClientOptions {
  /** How long a single request may stay unanswered. @default 5000 */
  readonly requestTimeoutMs?: number;
  /** Delay between `hello` retries while the page has not answered. @default 1000 */
  readonly helloIntervalMs?: number;
  /** Injectable timers, so tests do not have to wait in real time. */
  readonly setTimeout?: (handler: () => void, ms: number) => number;
  readonly clearTimeout?: (handle: number) => void;
}

/** Raised when a request outlives {@link BridgeClientOptions.requestTimeoutMs}. */
export class BridgeTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`bQuery DevTools: "${method}" did not answer within ${ms}ms`);
    this.name = 'BridgeTimeoutError';
  }
}

/** Raised when the page answers a request with an error string. */
export class BridgeMethodError extends Error {
  constructor(method: string, reason: string) {
    super(`bQuery DevTools: "${method}" failed: ${reason}`);
    this.name = 'BridgeMethodError';
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_HELLO_INTERVAL_MS = 1000;

/**
 * Drives one bridge conversation over a {@link BridgeTransport}.
 *
 * The client owns no UI; the panel subscribes to {@link BridgeClient.state},
 * {@link BridgeClient.capabilities} and {@link BridgeClient.onEvent}.
 */
export class BridgeClient {
  /** Current connection state (reactive). */
  public readonly state: Signal<ConnectionState> = signal<ConnectionState>('idle');
  /** Capabilities advertised by the page and understood here (reactive). */
  public readonly capabilities: Signal<ReadonlySet<BridgeCapability>> = signal<
    ReadonlySet<BridgeCapability>
  >(new Set<BridgeCapability>());
  /**
   * Every capability string the page advertised, including ones this panel has
   * no view for (reactive).
   *
   * {@link capabilities} is the negotiated subset the panel can act on; this is
   * the raw list, so the UI can point out that the page offers more than this
   * version of the extension understands.
   */
  public readonly advertised: Signal<readonly string[]> = signal<readonly string[]>([]);
  /** Human-readable detail for the current state (reactive). */
  public readonly detail: Signal<string> = signal('');

  private readonly transport: BridgeTransport;
  private readonly requestTimeoutMs: number;
  private readonly helloIntervalMs: number;
  private readonly setTimer: (handler: () => void, ms: number) => number;
  private readonly clearTimer: (handle: number) => void;

  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(entry: TimelineEntry) => void>();
  private readonly readyListeners = new Set<
    (capabilities: ReadonlySet<BridgeCapability>) => void
  >();

  private nextRequestId = 1;
  private helloTimer: number | null = null;
  /**
   * Set only by an `init` reply. The hello loop is driven by this rather than
   * by the displayed state: a page that streams an event before its handshake
   * reply arrives would otherwise stop the retries with no capabilities
   * negotiated, leaving every capability-gated view reporting "unsupported"
   * while the status bar claims the panel is connected.
   */
  private handshakeComplete = false;
  /** Foreign protocol version already reported, so it is said once, not per message. */
  private reportedForeignVersion: number | null = null;
  private disposed = false;
  private started = false;

  constructor(transport: BridgeTransport, options: BridgeClientOptions = {}) {
    this.transport = transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.helloIntervalMs = options.helloIntervalMs ?? DEFAULT_HELLO_INTERVAL_MS;
    this.setTimer =
      options.setTimeout ??
      ((handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number);
    this.clearTimer = options.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  }

  /** Which transport is in use — `'eval'` or `'port'`. */
  public get transportKind(): BridgeTransport['kind'] {
    return this.transport.kind;
  }

  /** Subscribe to streamed timeline entries. Returns an unsubscribe function. */
  public onEvent(listener: (entry: TimelineEntry) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Subscribe to successful handshakes. Fires on every (re)connect, so
   * consumers can refetch after a page navigation or a transport restart.
   */
  public onReady(listener: (capabilities: ReadonlySet<BridgeCapability>) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /** Start the transport and the handshake. */
  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.state.value = 'connecting';
    this.transport.start({
      onMessage: data => this.handleMessage(data),
      onStatus: status => this.handleStatus(status),
    });
  }

  /**
   * Restart the handshake without recreating the transport.
   *
   * Used on page navigation: the page-side bridge is gone, so anything in
   * flight is rejected and `hello` starts over.
   */
  public resetHandshake(reason = 'page navigated'): void {
    if (this.disposed) return;
    this.handshakeComplete = false;
    this.reportedForeignVersion = null;
    this.rejectAllPending(new Error(`bQuery DevTools: ${reason}`));
    this.capabilities.value = new Set<BridgeCapability>();
    this.advertised.value = [];
    this.state.value = 'waiting-for-page';
    this.detail.value = reason;
    this.scheduleHello(true);
  }

  /** Invoke a bridge method and await its result. */
  public async request<T = unknown>(
    method: BridgeMethodName | (string & {}),
    params?: unknown
  ): Promise<T> {
    if (this.disposed) throw new Error('bQuery DevTools: client disposed');
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        reject(new BridgeTimeoutError(method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      this.transport.send(requestMessage(id, method, params));
    });
  }

  /** Tear down the client and its transport. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelHello();
    this.rejectAllPending(new Error('bQuery DevTools: client disposed'));
    this.eventListeners.clear();
    this.readyListeners.clear();
    this.transport.dispose();
    this.state.value = 'idle';
  }

  private handleStatus(status: TransportStatus): void {
    if (this.disposed) return;
    switch (status.kind) {
      case 'connecting':
        this.state.value = 'connecting';
        return;
      case 'open':
        // The transport is up; the *page* still has to answer `hello`.
        this.state.value = 'waiting-for-page';
        this.detail.value = '';
        this.scheduleHello(true);
        return;
      case 'closed':
        this.handshakeComplete = false;
        this.cancelHello();
        this.rejectAllPending(new Error(`bQuery DevTools: ${status.reason}`));
        this.capabilities.value = new Set<BridgeCapability>();
        this.advertised.value = [];
        this.state.value = 'disconnected';
        this.detail.value = status.reason;
        return;
      case 'error':
        this.handshakeComplete = false;
        this.cancelHello();
        this.rejectAllPending(new Error(`bQuery DevTools: ${status.reason}`));
        this.state.value = 'error';
        this.detail.value = status.reason;
        return;
    }
  }

  private handleMessage(data: unknown): void {
    if (this.disposed) return;
    const message = parseOutbound(data);
    if (!message) {
      this.reportIfIncompatible(data);
      return;
    }

    switch (message.kind) {
      case 'init': {
        const negotiated = negotiateCapabilities(message.capabilities);
        this.handshakeComplete = true;
        this.cancelHello();
        this.advertised.value = message.capabilities;
        this.capabilities.value = negotiated;
        this.state.value = 'connected';
        this.detail.value = '';
        for (const listener of this.readyListeners) listener(negotiated);
        return;
      }
      case 'response': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        this.clearTimer(pending.timer);
        if (message.error !== undefined) {
          pending.reject(new BridgeMethodError(pending.method, message.error));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      case 'event': {
        // A streamed event proves the page is alive, so surface that — but it
        // is not a handshake, so the hello retries deliberately continue until
        // `init` answers with the capability list.
        if (this.state.value !== 'connected') this.state.value = 'connected';
        for (const listener of this.eventListeners) listener(message.entry);
        return;
      }
    }
  }

  /**
   * Surface a page that answers in a protocol version this panel cannot read.
   *
   * The message is still discarded — parsing a contract you do not understand
   * is how a validator becomes an attack surface — but the panel says so once
   * per distinct version instead of sitting in "waiting for the page" while
   * the page answers every `hello`.
   *
   * The handshake is deliberately *not* completed: `hello` keeps retrying, so
   * navigating to a compatible app recovers without reopening DevTools.
   */
  private reportIfIncompatible(data: unknown): void {
    const version = foreignProtocolVersion(data);
    if (version === null || version === this.reportedForeignVersion) return;
    this.reportedForeignVersion = version;
    this.state.value = 'incompatible';
    this.detail.value =
      `The page speaks bridge protocol v${version}; this panel speaks ` +
      `v${BRIDGE_PROTOCOL_VERSION}. Update the extension (or the app) so the two match.`;
  }

  private scheduleHello(immediate: boolean): void {
    this.cancelHello();
    const fire = (): void => {
      if (this.disposed || this.handshakeComplete) return;
      this.transport.send(helloMessage());
      this.helloTimer = this.setTimer(fire, this.helloIntervalMs);
    };
    if (immediate) fire();
    else this.helloTimer = this.setTimer(fire, this.helloIntervalMs);
  }

  private cancelHello(): void {
    if (this.helloTimer !== null) {
      this.clearTimer(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      this.clearTimer(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
