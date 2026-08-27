/**
 * Timeline buffering and filtering.
 *
 * A busy app can emit thousands of reactive events per second, so the panel
 * keeps a bounded ring buffer instead of an ever-growing array. The buffer
 * size is user-configurable (see the options page); dropping the oldest
 * entries is preferred over pausing the app or the panel.
 *
 * @module panel/timeline
 */
import type { TimelineEntry } from '../protocol/messages';

/** Filter applied to the buffered entries before rendering. */
export interface TimelineFilterState {
  /** Restrict to these event types; empty means "all types". */
  readonly types: ReadonlySet<string>;
  /** Case-insensitive substring match over `type`, `detail` and `source`. */
  readonly search: string;
}

/** Smallest buffer the UI offers. */
export const MIN_BUFFER_SIZE = 50;
/** Largest buffer the UI offers. */
export const MAX_BUFFER_SIZE = 20000;
/** Buffer size used when nothing is configured. */
export const DEFAULT_BUFFER_SIZE = 1000;

/** Clamp an arbitrary (possibly persisted) value into the supported range. */
export const clampBufferSize = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BUFFER_SIZE;
  return Math.min(MAX_BUFFER_SIZE, Math.max(MIN_BUFFER_SIZE, Math.floor(parsed)));
};

/**
 * Bounded, append-only timeline buffer.
 *
 * Entries are held oldest-first, matching the order the framework records
 * them, so index 0 is always the earliest retained event.
 */
export class TimelineBuffer {
  private entries: TimelineEntry[] = [];
  private limit: number;
  private droppedCount = 0;

  constructor(limit: number = DEFAULT_BUFFER_SIZE) {
    this.limit = clampBufferSize(limit);
  }

  /** Current buffer capacity. */
  public get capacity(): number {
    return this.limit;
  }

  /** Number of entries evicted since the last {@link clear}. */
  public get dropped(): number {
    return this.droppedCount;
  }

  /** Number of retained entries. */
  public get size(): number {
    return this.entries.length;
  }

  /** All retained entries, oldest first. */
  public all(): readonly TimelineEntry[] {
    return this.entries;
  }

  /** Append one entry, evicting the oldest when the buffer is full. */
  public push(entry: TimelineEntry): void {
    this.entries.push(entry);
    this.trim();
  }

  /** Append many entries at once (used when seeding from `getTimeline`). */
  public extend(entries: readonly TimelineEntry[]): void {
    for (const entry of entries) this.entries.push(entry);
    this.trim();
  }

  /** Replace the buffer contents wholesale. */
  public reset(entries: readonly TimelineEntry[] = []): void {
    this.entries = [...entries];
    this.droppedCount = 0;
    this.trim();
  }

  /** Drop everything, including the eviction counter. */
  public clear(): void {
    this.entries = [];
    this.droppedCount = 0;
  }

  /** Change the capacity, trimming immediately if it shrank. */
  public resize(limit: number): void {
    this.limit = clampBufferSize(limit);
    this.trim();
  }

  private trim(): void {
    const excess = this.entries.length - this.limit;
    if (excess > 0) {
      this.entries.splice(0, excess);
      this.droppedCount += excess;
    }
  }
}

/** Every event type present in the given entries, sorted for stable display. */
export const collectTypes = (entries: readonly TimelineEntry[]): string[] =>
  [...new Set(entries.map(entry => entry.type))].sort();

/** Apply a {@link TimelineFilterState} to buffered entries. */
export const filterEntries = (
  entries: readonly TimelineEntry[],
  filter: TimelineFilterState
): TimelineEntry[] => {
  const search = filter.search.trim().toLowerCase();
  return entries.filter(entry => {
    if (filter.types.size > 0 && !filter.types.has(entry.type)) return false;
    if (!search) return true;
    const haystack = `${entry.type} ${entry.detail} ${entry.source ?? ''}`.toLowerCase();
    return haystack.includes(search);
  });
};
