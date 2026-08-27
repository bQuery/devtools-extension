/**
 * Value formatting and drill-down.
 *
 * Signal and store values arrive as arbitrary JSON from the inspected page,
 * so rendering is done from a *described* model rather than from the raw
 * value: previews are truncated, cycles are broken, and every string that
 * reaches the DOM does so through a text sink.
 *
 * @module panel/valueTree
 */
import { UNKNOWN_VALUE } from './timeTravel';

/** Broad category of a described value, used for styling. */
export type ValueKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'array'
  | 'object'
  | 'function'
  | 'unknown';

/** One expandable child of a described value. */
export interface ValueEntry {
  readonly key: string;
  readonly value: unknown;
}

/** A value as the panel renders it. */
export interface DescribedValue {
  readonly kind: ValueKind;
  /** Single-line, length-capped preview. */
  readonly preview: string;
  /** Children, or `null` when the value is a leaf. */
  readonly entries: readonly ValueEntry[] | null;
}

/** Longest preview string rendered before truncation. */
export const PREVIEW_LIMIT = 120;

/** Most children listed for one container. */
export const ENTRY_LIMIT = 100;

const truncate = (text: string, limit = PREVIEW_LIMIT): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const previewPrimitive = (value: unknown): string => {
  if (typeof value === 'string') return truncate(JSON.stringify(value));
  if (typeof value === 'bigint') return `${value.toString()}n`;
  return String(value);
};

/**
 * Describe an arbitrary value for display.
 *
 * Never throws: exotic values (getters that throw, revoked proxies, cyclic
 * structures) degrade to an `unknown` description instead of breaking the
 * panel.
 */
export const describeValue = (value: unknown): DescribedValue => {
  if (value === UNKNOWN_VALUE) {
    return { kind: 'unknown', preview: '(not recorded)', entries: null };
  }
  if (value === null) return { kind: 'null', preview: 'null', entries: null };
  switch (typeof value) {
    case 'undefined':
      return { kind: 'undefined', preview: 'undefined', entries: null };
    case 'string':
      return { kind: 'string', preview: previewPrimitive(value), entries: null };
    case 'number':
      return { kind: 'number', preview: previewPrimitive(value), entries: null };
    case 'boolean':
      return { kind: 'boolean', preview: previewPrimitive(value), entries: null };
    case 'bigint':
      return { kind: 'number', preview: previewPrimitive(value), entries: null };
    case 'symbol':
      return { kind: 'unknown', preview: String(value), entries: null };
    case 'function':
      return { kind: 'function', preview: 'ƒ ()', entries: null };
    default:
      break;
  }

  try {
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, ENTRY_LIMIT)
        .map((item, index) => ({ key: String(index), value: item }));
      return {
        kind: 'array',
        preview: truncate(
          `Array(${value.length}) [${value.slice(0, 5).map(shortPreview).join(', ')}${value.length > 5 ? ', …' : ''}]`
        ),
        entries,
      };
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).slice(0, ENTRY_LIMIT);
    const entries = keys.map(key => ({ key, value: record[key] }));
    const head = keys
      .slice(0, 5)
      .map(key => `${key}: ${shortPreview(record[key])}`)
      .join(', ');
    return {
      kind: 'object',
      preview: truncate(`{${head}${keys.length > 5 ? ', …' : ''}}`),
      entries,
    };
  } catch {
    return { kind: 'unknown', preview: '(unreadable)', entries: null };
  }
};

/** A very short preview used inside container previews. */
export const shortPreview = (value: unknown): string => {
  if (value === UNKNOWN_VALUE) return '?';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return truncate(JSON.stringify(value), 24);
    case 'function':
      return 'ƒ';
    case 'object':
      return Array.isArray(value) ? `Array(${(value as unknown[]).length})` : '{…}';
    default:
      return truncate(String(value), 24);
  }
};

/**
 * `true` when the value can be expanded in the UI.
 *
 * An empty container is a leaf: there is nothing to drill into, and rendering
 * a toggle that opens onto nothing is worse than rendering none.
 */
export const isExpandable = (value: unknown): boolean =>
  (describeValue(value).entries?.length ?? 0) > 0;
