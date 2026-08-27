/**
 * Typed mirror of the stable bQuery DevTools bridge protocol (v1).
 *
 * The wire contract itself lives in `@bquery/bquery/devtools`
 * (`createBridgeServer` / `connectDevtoolsBridge`). This module re-states it
 * for the *panel* side of the wire, with two deliberate differences:
 *
 * 1. **No runtime import.** Only `typeof import(...)` type queries are used,
 *    so the page-side bridge runtime is never bundled into the extension —
 *    while the compiler still fails the build if the published protocol
 *    version or capability list changes underneath us.
 * 2. **Validation, not casts.** Everything arriving from the inspected page
 *    is attacker-controlled. `parseOutbound` narrows unknown input to a
 *    well-formed message or returns `null`; nothing else in the panel may
 *    assume a shape it did not check.
 *
 * @module protocol/messages
 */
import type { ComponentTreeNode, TimelineEntry } from '@bquery/bquery/devtools';

/**
 * Protocol version spoken by this panel.
 *
 * Typed as the published `BRIDGE_PROTOCOL_VERSION` literal, so bumping the
 * protocol upstream turns into a compile error here instead of a silent
 * runtime mismatch.
 */
export const BRIDGE_PROTOCOL_VERSION: typeof import('@bquery/bquery/devtools').BRIDGE_PROTOCOL_VERSION = 1;

/** Shared `source` discriminator carried by every bridge message. */
export const BRIDGE_SOURCE = 'bquery-devtools' as const;

/** A capability the inspected page can advertise in its `init` handshake. */
export type BridgeCapability =
  (typeof import('@bquery/bquery/devtools').BRIDGE_CAPABILITIES)[number];

/**
 * Every capability this panel knows how to make use of.
 *
 * Declared as a total `Record` over the published capability union rather than
 * a plain array: adding a capability upstream then fails to compile here,
 * instead of silently producing a panel with a feature it never renders and a
 * feature map missing an entry. Insertion order is the display order.
 */
const CAPABILITY_VIEWS: Readonly<Record<BridgeCapability, true>> = {
  signals: true,
  stores: true,
  components: true,
  timeline: true,
  'time-travel': true,
};

/** Every capability this panel knows how to make use of, in display order. */
export const KNOWN_CAPABILITIES = Object.keys(CAPABILITY_VIEWS) as readonly BridgeCapability[];

/** Built-in bridge methods (see `createBridgeServer`). */
export type BridgeMethodName = 'ping' | 'getSnapshot' | 'getTimeline' | 'getComponentTree';

export type { ComponentTreeNode, TimelineEntry };

/** Panel → page: announce the panel; the page answers with `init`. */
export interface HelloMessage {
  source: typeof BRIDGE_SOURCE;
  channel: 'panel';
  v: number;
  kind: 'hello';
}

/** Panel → page: invoke a bridge method. */
export interface RequestMessage {
  source: typeof BRIDGE_SOURCE;
  channel: 'panel';
  v: number;
  kind: 'request';
  id: number;
  method: string;
  params?: unknown;
}

/** Anything the panel puts on the wire. */
export type InboundMessage = HelloMessage | RequestMessage;

/** Page → panel: handshake carrying the advertised capabilities. */
export interface InitMessage {
  source: typeof BRIDGE_SOURCE;
  channel: 'page';
  v: number;
  kind: 'init';
  capabilities: readonly string[];
}

/** Page → panel: the answer to one {@link RequestMessage}. */
export interface ResponseMessage {
  source: typeof BRIDGE_SOURCE;
  channel: 'page';
  v: number;
  kind: 'response';
  id: number;
  result?: unknown;
  error?: string;
}

/** Page → panel: a streamed timeline entry. */
export interface EventMessage {
  source: typeof BRIDGE_SOURCE;
  channel: 'page';
  v: number;
  kind: 'event';
  entry: TimelineEntry;
}

/** Anything the page may put on the wire. */
export type OutboundMessage = InitMessage | ResponseMessage | EventMessage;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Build the `hello` handshake message. */
export const helloMessage = (): HelloMessage => ({
  source: BRIDGE_SOURCE,
  channel: 'panel',
  v: BRIDGE_PROTOCOL_VERSION,
  kind: 'hello',
});

/** Build a `request` message. */
export const requestMessage = (id: number, method: string, params?: unknown): RequestMessage => ({
  source: BRIDGE_SOURCE,
  channel: 'panel',
  v: BRIDGE_PROTOCOL_VERSION,
  kind: 'request',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

/**
 * Normalize a timeline entry coming off the wire.
 *
 * Only the fields the protocol defines survive; `payload` is kept as opaque
 * `unknown` (it is app-defined) and every displayed field is coerced to a
 * primitive so the renderer can never be handed an exotic object.
 */
const parseTimelineEntry = (value: unknown): TimelineEntry | null => {
  if (!isRecord(value)) return null;
  if (typeof value['type'] !== 'string') return null;
  const timestamp = typeof value['timestamp'] === 'number' ? value['timestamp'] : Date.now();
  const detail =
    typeof value['detail'] === 'string' ? value['detail'] : String(value['detail'] ?? '');
  const entry: Record<string, unknown> = {
    timestamp,
    type: value['type'],
    detail,
  };
  if (value['payload'] !== undefined) entry['payload'] = value['payload'];
  if (typeof value['source'] === 'string') entry['source'] = value['source'];
  if (typeof value['duration'] === 'number') entry['duration'] = value['duration'];
  return entry as unknown as TimelineEntry;
};

/**
 * Narrow an untrusted value to a well-formed page → panel message.
 *
 * Returns `null` for anything that is not a fully-formed message of a kind
 * this panel understands — including messages from a different protocol
 * version, which are rejected rather than best-effort parsed.
 */
export const parseOutbound = (data: unknown): OutboundMessage | null => {
  if (!isRecord(data)) return null;
  if (data['source'] !== BRIDGE_SOURCE || data['channel'] !== 'page') return null;
  if (data['v'] !== BRIDGE_PROTOCOL_VERSION) return null;

  switch (data['kind']) {
    case 'init': {
      const capabilities = Array.isArray(data['capabilities'])
        ? data['capabilities'].filter((entry): entry is string => typeof entry === 'string')
        : [];
      return {
        source: BRIDGE_SOURCE,
        channel: 'page',
        v: BRIDGE_PROTOCOL_VERSION,
        kind: 'init',
        capabilities,
      };
    }
    case 'response': {
      if (typeof data['id'] !== 'number') return null;
      const message: ResponseMessage = {
        source: BRIDGE_SOURCE,
        channel: 'page',
        v: BRIDGE_PROTOCOL_VERSION,
        kind: 'response',
        id: data['id'],
      };
      if (typeof data['error'] === 'string') return { ...message, error: data['error'] };
      return { ...message, result: data['result'] };
    }
    case 'event': {
      const entry = parseTimelineEntry(data['entry']);
      if (!entry) return null;
      return {
        source: BRIDGE_SOURCE,
        channel: 'page',
        v: BRIDGE_PROTOCOL_VERSION,
        kind: 'event',
        entry,
      };
    }
    default:
      return null;
  }
};

/**
 * The protocol version of a bridge message this panel cannot speak.
 *
 * `parseOutbound` drops such messages, which is the safe thing to do with a
 * contract you do not understand — but dropping them silently leaves the panel
 * waiting forever on a page that is, in fact, answering. This lets the client
 * say so instead.
 *
 * Returns `null` for anything that is not a page-side bridge message, and for
 * messages this panel *can* speak.
 */
export const foreignProtocolVersion = (data: unknown): number | null => {
  if (!isRecord(data)) return null;
  if (data['source'] !== BRIDGE_SOURCE || data['channel'] !== 'page') return null;
  const version = data['v'];
  if (typeof version !== 'number' || version === BRIDGE_PROTOCOL_VERSION) return null;
  return version;
};

/**
 * Capabilities the page advertised that this panel has no view for.
 *
 * Not an error — a newer framework may advertise more than this panel knows —
 * but worth surfacing, because it is the visible symptom of an extension that
 * has fallen behind the app it is inspecting.
 */
export const unknownCapabilities = (advertised: readonly string[]): string[] => {
  const known = new Set<string>(KNOWN_CAPABILITIES);
  return advertised.filter(capability => !known.has(capability));
};

/** Keep only the capabilities this panel actually implements a view for. */
export const negotiateCapabilities = (advertised: readonly string[]): Set<BridgeCapability> => {
  const known = new Set<string>(KNOWN_CAPABILITIES);
  const out = new Set<BridgeCapability>();
  for (const capability of advertised) {
    if (known.has(capability)) out.add(capability as BridgeCapability);
  }
  return out;
};
