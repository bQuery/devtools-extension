/**
 * Transport abstraction for the panel side of the bridge.
 *
 * Two transports implement this interface:
 *
 * - {@link ../transports/evalTransport | EvalTransport} — the default. Talks to
 *   the page through `chrome.devtools.inspectedWindow.eval`, which needs **no
 *   host permission at all**, and polls for page → panel messages.
 * - {@link ../transports/portTransport | PortTransport} — opt-in live
 *   streaming through an injected content script and the background router.
 *   Costs one origin permission, granted per site by the user.
 *
 * Keeping both behind one interface is what lets the extension ship with an
 * empty `host_permissions` list and still offer push-based streaming.
 *
 * @module protocol/transport
 */
import type { InboundMessage } from './messages';

/** Lifecycle state of a transport. */
export type TransportStatus =
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; reason: string };

/** Callbacks a transport reports back into the client. */
export interface TransportHandlers {
  /** One raw, still-untrusted message from the page. */
  readonly onMessage: (data: unknown) => void;
  /** Transport lifecycle change. */
  readonly onStatus: (status: TransportStatus) => void;
}

/** A panel ⇄ page message channel. */
export interface BridgeTransport {
  /** Which transport this is; surfaced in the panel status bar. */
  readonly kind: 'eval' | 'port';
  /** Begin connecting. Safe to call once per instance. */
  start(handlers: TransportHandlers): void;
  /** Put one panel → page message on the wire. */
  send(message: InboundMessage): void;
  /** Tear everything down; the instance is unusable afterwards. */
  dispose(): void;
}
