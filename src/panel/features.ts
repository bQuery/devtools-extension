/**
 * Feature availability, decided by evidence rather than by advertisement.
 *
 * bQuery is modular: an app may load `reactive` without `store`, `component`
 * without `router`, or the devtools bridge on its own. The framework's
 * `createBridgeServer` nevertheless advertises the *full* capability list in
 * its `init` handshake, and a trimmed or hand-rolled bridge may do the
 * opposite — advertise nothing while answering every method.
 *
 * The advertised set is therefore treated as a hint. What the panel renders is
 * decided by what the page actually answered:
 *
 * - `unknown` — not attempted yet on this connection.
 * - `available` — the page returned data this panel could parse.
 * - `unsupported` — the page cannot serve it at all (no such method, or an
 *   unusable result). Not retried until the next handshake or an explicit
 *   user refresh, so an absent feature costs one request per connection.
 * - `failed` — it *should* work but the last attempt did not. Retried on the
 *   next refresh.
 *
 * Every feature is independent: one unsupported section never stops another
 * from loading.
 *
 * @module panel/features
 */
import { BridgeMethodError, BridgeTimeoutError } from '../protocol/client';
import { KNOWN_CAPABILITIES, type BridgeCapability } from '../protocol/messages';

/** A panel feature. One per advertised bridge capability. */
export type FeatureName = BridgeCapability;

/** How a feature came out the last time the panel tried to use it. */
export type FeatureStatus = 'unknown' | 'available' | 'unsupported' | 'failed';

/** Availability of one feature on the current connection. */
export interface FeatureState {
  readonly status: FeatureStatus;
  /** Why, in the page's own words where there are any. Empty when uneventful. */
  readonly detail: string;
  /** Whether the page listed this capability in its `init` handshake. */
  readonly advertised: boolean;
}

/** Availability of every feature. */
export type FeatureMap = Readonly<Record<FeatureName, FeatureState>>;

const UNKNOWN_METHOD = /unknown method/i;

/** The initial map: nothing attempted, nothing advertised. */
export const initialFeatures = (): FeatureMap => {
  const out = {} as Record<FeatureName, FeatureState>;
  for (const name of KNOWN_CAPABILITIES) {
    out[name] = { status: 'unknown', detail: '', advertised: false };
  }
  return out;
};

/** Reset every feature for a fresh handshake, recording what was advertised. */
export const featuresForHandshake = (advertised: ReadonlySet<FeatureName>): FeatureMap => {
  const out = {} as Record<FeatureName, FeatureState>;
  for (const name of KNOWN_CAPABILITIES) {
    out[name] = { status: 'unknown', detail: '', advertised: advertised.has(name) };
  }
  return out;
};

/** Replace one feature's state, leaving the others untouched. */
export const withFeature = (map: FeatureMap, name: FeatureName, next: FeatureState): FeatureMap => {
  const status = map[name];
  if (status.status === next.status && status.detail === next.detail) return map;
  return { ...map, [name]: next };
};

/**
 * Whether the panel should issue a request for this feature.
 *
 * `unsupported` is the one status that stops the panel asking again: the page
 * has already said it cannot serve this, and repeating the request every
 * refresh would only buy a second timeout. An explicit user refresh clears it
 * (see {@link retryFeature}).
 */
export const shouldAttempt = (state: FeatureState, force: boolean): boolean =>
  force || state.status !== 'unsupported';

/** Clear a permanent verdict so the next refresh probes again. */
export const retryFeature = (state: FeatureState): FeatureState =>
  state.status === 'unsupported' ? { ...state, status: 'unknown', detail: '' } : state;

/** Clear every permanent verdict. Used by the explicit "Refresh all" button. */
export const retryAll = (map: FeatureMap): FeatureMap => {
  const out = {} as Record<FeatureName, FeatureState>;
  for (const name of KNOWN_CAPABILITIES) out[name] = retryFeature(map[name]);
  return out;
};

/** The page answered with data this panel could use. */
export const featureAvailable = (state: FeatureState, detail = ''): FeatureState => ({
  ...state,
  status: 'available',
  detail,
});

/** The page cannot serve this feature at all. */
export const featureUnsupported = (state: FeatureState, detail: string): FeatureState => ({
  ...state,
  status: 'unsupported',
  detail,
});

/**
 * Classify a failed request.
 *
 * The distinction that matters is permanent versus transient, because it
 * decides whether the panel asks again:
 *
 * - "Unknown method" is the bridge server's own answer for a method it does
 *   not implement — permanent, and the single most likely outcome against a
 *   partially implemented bridge.
 * - A timeout on a feature the page never advertised is treated as permanent
 *   too: nothing suggests it exists, and re-probing would stall every refresh
 *   for the request timeout. A timeout on an *advertised* feature is
 *   transient — the page said it has it, so a slow answer deserves a retry.
 * - Anything else (the page threw, devtools are disabled, a store registry is
 *   empty) is transient: the user can fix it and hit Refresh.
 */
export const classifyFailure = (state: FeatureState, error: unknown): FeatureState => {
  if (error instanceof BridgeMethodError && UNKNOWN_METHOD.test(error.message)) {
    return featureUnsupported(state, 'the page does not implement this bridge method');
  }
  if (error instanceof BridgeTimeoutError) {
    return state.advertised
      ? { ...state, status: 'failed', detail: 'the page did not answer in time' }
      : featureUnsupported(state, 'the page did not answer, and never advertised it');
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { ...state, status: 'failed', detail: stripPrefix(detail) };
};

/** The page answered, but with something this panel cannot read. */
export const featureUnusable = (state: FeatureState): FeatureState =>
  featureUnsupported(state, 'the page answered with a result this panel cannot read');

/** Trim the client's own `bQuery DevTools: "method" failed:` framing. */
const stripPrefix = (message: string): string =>
  message.replace(/^bQuery DevTools: (?:"[^"]*" failed: )?/, '');

/** Tooltip for a capability badge, in the same evidence-first terms. */
export const featureTitle = (name: FeatureName, state: FeatureState): string => {
  switch (state.status) {
    case 'available':
      return `The page serves "${name}".`;
    case 'unsupported':
      return `"${name}" is not available: ${state.detail}.`;
    case 'failed':
      return `The last attempt at "${name}" failed: ${state.detail}.`;
    case 'unknown':
      return state.advertised
        ? `The page advertised "${name}"; the panel has not loaded it yet.`
        : `The page did not advertise "${name}".`;
  }
};

/**
 * The sentence a view shows when it has nothing to display.
 *
 * `whenAvailable` covers the ordinary case — the feature works, the app simply
 * has none of whatever it lists.
 */
export const emptyMessage = (state: FeatureState, label: string, whenAvailable: string): string => {
  switch (state.status) {
    case 'available':
      return whenAvailable;
    case 'unsupported':
      return `This page does not provide ${label}: ${state.detail}.`;
    case 'failed':
      return `Could not load ${label}: ${state.detail}.`;
    case 'unknown':
      return state.advertised ? `Loading ${label}…` : `This page has not reported ${label} yet.`;
  }
};
