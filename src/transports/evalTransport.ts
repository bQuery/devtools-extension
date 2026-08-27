/**
 * Default transport: `chrome.devtools.inspectedWindow.eval`.
 *
 * A DevTools panel may evaluate script in the page it is inspecting without
 * any host permission — that is what lets this extension ship with an empty
 * `host_permissions` list. The trade-off is that the page cannot push to us,
 * so a tiny in-page relay buffers bridge messages and the panel drains that
 * buffer on a timer.
 *
 * The relay is (re)installed on every poll, which also makes the transport
 * self-healing across page navigations: a reload wipes the relay, the next
 * poll puts it back.
 *
 * @module transports/evalTransport
 */
import { extensionApi } from '../browser';
import { BRIDGE_SOURCE, type InboundMessage } from '../protocol/messages';
import type { BridgeTransport, TransportHandlers } from '../protocol/transport';

/** Options for {@link EvalTransport}. */
export interface EvalTransportOptions {
  /** How often to drain the in-page queue, in ms. @default 250 */
  readonly pollIntervalMs?: number;
  /** Cap on messages buffered in the page between two polls. @default 2000 */
  readonly queueLimit?: number;
}

/** Global the relay hangs off in the inspected page. */
const RELAY_GLOBAL = '__BQUERY_DEVTOOLS_PANEL__';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_QUEUE_LIMIT = 2000;

/**
 * Build the expression that installs the relay (if absent) and returns the
 * buffered messages as a JSON string.
 *
 * Exported for unit testing: the expression is built by string concatenation
 * and must stay syntactically valid and free of interpolation holes.
 */
export const buildDrainExpression = (queueLimit = DEFAULT_QUEUE_LIMIT): string => `(function () {
  var g = window[${JSON.stringify(RELAY_GLOBAL)}];
  if (!g) {
    g = window[${JSON.stringify(RELAY_GLOBAL)}] = { queue: [] };
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (event.source !== window) return;
      if (!data || data.source !== ${JSON.stringify(BRIDGE_SOURCE)} || data.channel !== 'page') return;
      g.queue.push(data);
      if (g.queue.length > ${queueLimit}) g.queue.splice(0, g.queue.length - ${queueLimit});
    });
  }
  var drained = g.queue;
  g.queue = [];
  try {
    return JSON.stringify(drained);
  } catch (error) {
    return JSON.stringify([]);
  }
})()`;

/**
 * Build the expression that posts one panel → page message.
 *
 * The message is embedded as a JSON *string literal* and parsed in the page,
 * so no value from panel state is ever spliced into evaluated source.
 */
export const buildSendExpression = (message: InboundMessage): string => {
  const literal = JSON.stringify(JSON.stringify(message))
    // U+2028/U+2029 are legal inside JSON strings; escape them so the
    // embedded literal is unambiguous in every JavaScript parser.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.postMessage(JSON.parse(${literal}), '*')`;
};

/** A `chrome.devtools.inspectedWindow.eval`-compatible evaluator. */
export type Evaluator = (
  expression: string,
  callback: (result: unknown, exceptionInfo?: unknown) => void
) => void;

const isFailure = (exceptionInfo: unknown): boolean => {
  if (!exceptionInfo || typeof exceptionInfo !== 'object') return false;
  const info = exceptionInfo as { isError?: unknown; isException?: unknown };
  return Boolean(info.isError) || Boolean(info.isException);
};

/** Polling transport built on `inspectedWindow.eval`. */
export class EvalTransport implements BridgeTransport {
  public readonly kind = 'eval' as const;

  private readonly evaluate: Evaluator;
  private readonly pollIntervalMs: number;
  private readonly drainExpression: string;

  private handlers: TransportHandlers | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private lastFailure = '';

  constructor(options: EvalTransportOptions & { evaluate?: Evaluator } = {}) {
    this.evaluate =
      options.evaluate ??
      ((expression, callback) => {
        extensionApi().devtools.inspectedWindow.eval(expression, callback);
      });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.drainExpression = buildDrainExpression(options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
  }

  public start(handlers: TransportHandlers): void {
    if (this.disposed || this.handlers) return;
    this.handlers = handlers;
    handlers.onStatus({ kind: 'connecting' });
    // The relay is installed by the first drain, so the transport is "open"
    // as soon as one poll round-trips without an evaluation error.
    this.poll(true);
    this.timer = setInterval(() => this.poll(false), this.pollIntervalMs);
  }

  public send(message: InboundMessage): void {
    if (this.disposed) return;
    this.evaluate(buildSendExpression(message), (_result, exceptionInfo) => {
      if (isFailure(exceptionInfo)) this.reportFailure('cannot evaluate in the inspected page');
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.handlers = null;
  }

  private poll(announceOpen: boolean): void {
    this.evaluate(this.drainExpression, (result, exceptionInfo) => {
      if (this.disposed || !this.handlers) return;
      if (isFailure(exceptionInfo)) {
        this.reportFailure('cannot evaluate in the inspected page');
        return;
      }
      if (announceOpen || this.lastFailure) {
        this.lastFailure = '';
        this.handlers.onStatus({ kind: 'open' });
      }
      for (const message of this.decode(result)) this.handlers.onMessage(message);
    });
  }

  private decode(result: unknown): unknown[] {
    if (typeof result !== 'string') return Array.isArray(result) ? result : [];
    try {
      const parsed: unknown = JSON.parse(result);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private reportFailure(reason: string): void {
    if (!this.handlers || this.lastFailure === reason) return;
    this.lastFailure = reason;
    this.handlers.onStatus({ kind: 'error', reason });
  }
}
