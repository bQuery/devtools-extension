/**
 * Time travel over the reactive timeline.
 *
 * The bridge exposes primitives, not history: `getSnapshot` gives the state
 * *now*, and `event` messages stream what changed afterwards. Time travel is
 * therefore reconstructed on the panel side — take the snapshot captured at
 * connect as the base, then replay recorded events up to a chosen point.
 *
 * Event payloads are app-defined (`payload?: unknown`), so replay is
 * deliberately tolerant: a value that cannot be derived is reported as
 * {@link UNKNOWN_VALUE} rather than guessed, and the UI marks it as such. The
 * reconstruction never mutates the page — it is a read-only view of history.
 *
 * @module panel/timeTravel
 */
import type { TimelineEntry } from '../protocol/messages';
import type { SignalView, StoreView } from '../protocol/results';

/** Marker for a value the replay could not derive from the recorded payload. */
export const UNKNOWN_VALUE = Symbol('bquery-devtools/unknown-value');

/** One reconstructed signal at a point in time. */
export interface ReconstructedSignal {
  readonly label: string;
  readonly value: unknown;
  /** `true` when the value is the base snapshot's, untouched by replay. */
  readonly fromBase: boolean;
  /** `true` when an event changed this signal but carried no usable payload. */
  readonly unresolved: boolean;
}

/** One reconstructed store at a point in time. */
export interface ReconstructedStore {
  readonly id: string;
  readonly state: Record<string, unknown>;
  readonly fromBase: boolean;
  readonly unresolved: boolean;
}

/** Result of {@link reconstructAt}. */
export interface Reconstruction {
  /** Index (inclusive) of the last replayed entry; `-1` for "base state". */
  readonly index: number;
  /** Timestamp of that entry, or the snapshot time for the base state. */
  readonly timestamp: number;
  readonly signals: readonly ReconstructedSignal[];
  readonly stores: readonly ReconstructedStore[];
  /** Number of replayed entries that changed something. */
  readonly appliedCount: number;
  /** Number of replayed entries whose payload could not be interpreted. */
  readonly unresolvedCount: number;
}

/** The base state time travel replays from. */
export interface TimeTravelBase {
  readonly signals: readonly SignalView[];
  readonly stores: readonly StoreView[];
  readonly capturedAt: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Derive the new signal value carried by an entry.
 *
 * Recognized shapes, in order: `{ value }`, `{ next }`, `{ to }`, and finally
 * the payload itself when it is not an object wrapper. Anything else is
 * unknown — the framework does not mandate a payload shape.
 */
export const extractSignalValue = (entry: TimelineEntry): unknown => {
  const payload: unknown = entry.payload;
  if (payload === undefined) return UNKNOWN_VALUE;
  if (isPlainObject(payload)) {
    if ('value' in payload) return payload['value'];
    if ('next' in payload) return payload['next'];
    if ('to' in payload) return payload['to'];
    return payload;
  }
  return payload;
};

/**
 * Derive the state patch carried by a store entry.
 *
 * Recognized shapes: `{ patch }`, `{ state }`, `{ next }`, or a plain object
 * payload used directly as the patch.
 */
export const extractStorePatch = (entry: TimelineEntry): Record<string, unknown> | undefined => {
  const payload: unknown = entry.payload;
  if (!isPlainObject(payload)) return undefined;
  for (const key of ['patch', 'state', 'next'] as const) {
    const nested: unknown = payload[key];
    if (isPlainObject(nested)) return nested;
  }
  return payload;
};

/** `true` when this entry type participates in state reconstruction. */
export const isReplayable = (entry: TimelineEntry): boolean =>
  entry.type === 'signal:update' ||
  entry.type === 'signal:create' ||
  entry.type === 'store:patch' ||
  entry.type === 'store:action';

interface SignalCell {
  value: unknown;
  fromBase: boolean;
  unresolved: boolean;
}

interface StoreCell {
  state: Record<string, unknown>;
  fromBase: boolean;
  unresolved: boolean;
}

/**
 * Reconstruct signal and store state as of `index` in `entries`.
 *
 * @param base    State captured when the panel connected.
 * @param entries Events recorded after the base, oldest first.
 * @param index   Inclusive index to replay up to; `-1` yields the base state,
 *                values past the end are clamped to the last entry.
 */
export const reconstructAt = (
  base: TimeTravelBase,
  entries: readonly TimelineEntry[],
  index: number
): Reconstruction => {
  const upto = Math.min(index, entries.length - 1);
  const signals = new Map<string, SignalCell>();
  for (const signal of base.signals) {
    signals.set(signal.label, { value: signal.value, fromBase: true, unresolved: false });
  }
  const stores = new Map<string, StoreCell>();
  for (const store of base.stores) {
    stores.set(store.id, { state: { ...store.state }, fromBase: true, unresolved: false });
  }

  let appliedCount = 0;
  let unresolvedCount = 0;

  for (let cursor = 0; cursor <= upto; cursor += 1) {
    const entry = entries[cursor];
    if (!entry || !isReplayable(entry)) continue;
    const key = entry.source ?? entry.detail;
    if (!key) continue;

    if (entry.type === 'signal:update' || entry.type === 'signal:create') {
      const value = extractSignalValue(entry);
      const unresolved = value === UNKNOWN_VALUE;
      if (unresolved) unresolvedCount += 1;
      else appliedCount += 1;
      const previous = signals.get(key);
      signals.set(key, {
        value: unresolved ? (previous?.value ?? UNKNOWN_VALUE) : value,
        fromBase: false,
        unresolved,
      });
      continue;
    }

    const patch = extractStorePatch(entry);
    const previous = stores.get(key);
    if (!patch) {
      unresolvedCount += 1;
      stores.set(key, {
        state: previous?.state ?? {},
        fromBase: false,
        unresolved: true,
      });
      continue;
    }
    appliedCount += 1;
    stores.set(key, {
      state: { ...(previous?.state ?? {}), ...patch },
      fromBase: false,
      unresolved: false,
    });
  }

  const at = upto >= 0 ? entries[upto] : undefined;

  return {
    index: upto,
    timestamp: at?.timestamp ?? base.capturedAt,
    appliedCount,
    unresolvedCount,
    signals: [...signals.entries()]
      .map(([label, cell]) => ({
        label,
        value: cell.value,
        fromBase: cell.fromBase,
        unresolved: cell.unresolved,
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    stores: [...stores.entries()]
      .map(([id, cell]) => ({
        id,
        state: cell.state,
        fromBase: cell.fromBase,
        unresolved: cell.unresolved,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
};
