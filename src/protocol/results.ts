/**
 * Validators for bridge *method results*.
 *
 * `getSnapshot`, `getTimeline` and `getComponentTree` all return data shaped
 * by the inspected page. The page is untrusted, so every result is narrowed
 * here before it reaches panel state; malformed members are dropped rather
 * than rendered.
 *
 * @module protocol/results
 */
import type { ComponentTreeNode, TimelineEntry } from './messages';

/** A signal as displayed by the panel. */
export interface SignalView {
  readonly label: string;
  readonly value: unknown;
  readonly subscriberCount: number;
}

/** A store as displayed by the panel. */
export interface StoreView {
  readonly id: string;
  readonly state: Record<string, unknown>;
}

/** A registered component (flat view) as displayed by the panel. */
export interface ComponentView {
  readonly tagName: string;
  readonly instanceCount: number;
}

/**
 * Which top-level collections a snapshot actually carried.
 *
 * An app that loads `reactive` but not `store` produces a snapshot with no
 * usable `stores` array. "Absent" and "empty" mean different things to a
 * reader — *the page does not report stores* versus *the page has no stores* —
 * so the two are kept apart here instead of both collapsing to `[]`.
 */
export interface SnapshotPresence {
  readonly signals: boolean;
  readonly stores: boolean;
  readonly components: boolean;
}

/** Normalized `getSnapshot` result. */
export interface SnapshotView {
  readonly signals: readonly SignalView[];
  readonly stores: readonly StoreView[];
  readonly components: readonly ComponentView[];
  readonly timeline: readonly TimelineEntry[];
  readonly exportedAt: number;
  /** Which collections the page reported at all. */
  readonly reported: SnapshotPresence;
}

/** Normalized `getComponentTree` result. */
export interface ComponentTreeView {
  readonly tree: readonly ComponentTreeNode[];
  readonly flat: readonly ComponentView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const toStringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/** Narrow one signal snapshot; `null` when it is unusable. */
export const parseSignal = (value: unknown): SignalView | null => {
  if (!isRecord(value)) return null;
  const label = toStringValue(value['label'], toStringValue(value['id'], '(unlabeled)'));
  return {
    label,
    value: value['value'],
    subscriberCount: toNumber(value['subscriberCount']),
  };
};

/** Narrow one store snapshot; `null` when it is unusable. */
export const parseStore = (value: unknown): StoreView | null => {
  if (!isRecord(value)) return null;
  const id = toStringValue(value['id']);
  if (!id) return null;
  const state = isRecord(value['state']) ? value['state'] : {};
  return { id, state };
};

/** Narrow one component snapshot; `null` when it is unusable. */
export const parseComponent = (value: unknown): ComponentView | null => {
  if (!isRecord(value)) return null;
  const tagName = toStringValue(value['tagName']);
  if (!tagName) return null;
  return { tagName, instanceCount: toNumber(value['instanceCount']) };
};

const parseArray = <T>(value: unknown, parse: (entry: unknown) => T | null): T[] => {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed) out.push(parsed);
  }
  return out;
};

/** Narrow one timeline entry; `null` when it is unusable. */
export const parseEntry = (value: unknown): TimelineEntry | null => {
  if (!isRecord(value)) return null;
  if (typeof value['type'] !== 'string') return null;
  const entry: Record<string, unknown> = {
    timestamp: toNumber(value['timestamp'], Date.now()),
    type: value['type'],
    detail: toStringValue(value['detail']),
  };
  if (value['payload'] !== undefined) entry['payload'] = value['payload'];
  if (typeof value['source'] === 'string') entry['source'] = value['source'];
  if (typeof value['duration'] === 'number') entry['duration'] = value['duration'];
  return entry as unknown as TimelineEntry;
};

/** Narrow a timeline array wherever one is embedded (e.g. inside a snapshot). */
export const parseTimeline = (value: unknown): TimelineEntry[] => parseArray(value, parseEntry);

/**
 * Narrow a `getTimeline` *result*.
 *
 * `null` when the page answered with something that is not a list at all —
 * which the caller reads as "this page cannot serve a timeline", as opposed to
 * an empty list, which means "nothing has happened yet".
 */
export const parseTimelineResult = (value: unknown): TimelineEntry[] | null =>
  Array.isArray(value) ? parseArray(value, parseEntry) : null;

/**
 * Narrow a `DevtoolsSnapshot` as produced by `exportDevtoolsSnapshot()`.
 *
 * The nested `state.timeline` is lifted to the top level so consumers do not
 * have to know where the framework happens to keep it.
 */
export const parseSnapshot = (value: unknown): SnapshotView | null => {
  // `isRecord` admits arrays, and an array result would parse into an
  // all-empty snapshot that then wipes the panel's signals and stores.
  if (!isRecord(value) || Array.isArray(value)) return null;
  const state = isRecord(value['state']) ? value['state'] : {};
  return {
    signals: parseArray(value['signals'], parseSignal),
    stores: parseArray(value['stores'], parseStore),
    components: parseArray(value['components'], parseComponent),
    timeline: parseTimeline(state['timeline']),
    exportedAt: toNumber(value['exportedAt'], Date.now()),
    reported: {
      signals: Array.isArray(value['signals']),
      stores: Array.isArray(value['stores']),
      components: Array.isArray(value['components']),
    },
  };
};

/**
 * Narrow one component-tree node, recursively.
 *
 * Depth is capped so a hostile (or merely pathological) page cannot blow the
 * stack of the panel with a deeply self-nested tree.
 */
const parseTreeNode = (value: unknown, depth = 0): ComponentTreeNode | null => {
  if (depth > 100 || !isRecord(value)) return null;
  const tag = toStringValue(value['tag']);
  if (!tag) return null;
  const attrs: Record<string, string> = {};
  if (isRecord(value['attrs'])) {
    for (const [key, attrValue] of Object.entries(value['attrs'])) {
      if (typeof attrValue === 'string') attrs[key] = attrValue;
    }
  }
  const children: ComponentTreeNode[] = [];
  if (Array.isArray(value['children'])) {
    for (const child of value['children']) {
      const parsed = parseTreeNode(child, depth + 1);
      if (parsed) children.push(parsed);
    }
  }
  return { tag, id: toStringValue(value['id']), attrs, children };
};

/**
 * Narrow a `getComponentTree` result; `null` when it is not a result at all.
 *
 * A page that answers `undefined` (or a string, or a number) has not given the
 * panel a tree — reporting that as an empty tree would claim, wrongly, that
 * the page has no components.
 */
export const parseComponentTree = (value: unknown): ComponentTreeView | null => {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const tree: ComponentTreeNode[] = [];
  if (Array.isArray(value['tree'])) {
    for (const node of value['tree']) {
      const parsed = parseTreeNode(node);
      if (parsed) tree.push(parsed);
    }
  }
  return { tree, flat: parseArray(value['flat'], parseComponent) };
};
