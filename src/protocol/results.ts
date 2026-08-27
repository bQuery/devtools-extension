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

/** Normalized `getSnapshot` result. */
export interface SnapshotView {
  readonly signals: readonly SignalView[];
  readonly stores: readonly StoreView[];
  readonly components: readonly ComponentView[];
  readonly timeline: readonly TimelineEntry[];
  readonly exportedAt: number;
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

/** Narrow a `getTimeline` result. */
export const parseTimeline = (value: unknown): TimelineEntry[] => parseArray(value, parseEntry);

/**
 * Narrow a `DevtoolsSnapshot` as produced by `exportDevtoolsSnapshot()`.
 *
 * The nested `state.timeline` is lifted to the top level so consumers do not
 * have to know where the framework happens to keep it.
 */
export const parseSnapshot = (value: unknown): SnapshotView | null => {
  if (!isRecord(value)) return null;
  const state = isRecord(value['state']) ? value['state'] : {};
  return {
    signals: parseArray(value['signals'], parseSignal),
    stores: parseArray(value['stores'], parseStore),
    components: parseArray(value['components'], parseComponent),
    timeline: parseTimeline(state['timeline']),
    exportedAt: toNumber(value['exportedAt'], Date.now()),
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

/** Narrow a `getComponentTree` result. */
export const parseComponentTree = (value: unknown): ComponentTreeView => {
  if (!isRecord(value)) return { tree: [], flat: [] };
  const tree: ComponentTreeNode[] = [];
  if (Array.isArray(value['tree'])) {
    for (const node of value['tree']) {
      const parsed = parseTreeNode(node);
      if (parsed) tree.push(parsed);
    }
  }
  return { tree, flat: parseArray(value['flat'], parseComponent) };
};
