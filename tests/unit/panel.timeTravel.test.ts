import { describe, expect, test } from 'bun:test';
import type { TimelineEntry } from '../../src/protocol/messages';
import {
  extractSignalValue,
  extractStorePatch,
  isReplayable,
  reconstructAt,
  UNKNOWN_VALUE,
  type TimeTravelBase,
} from '../../src/panel/timeTravel';

// Defaults to a timestamp *after* `base.capturedAt`: entries older than the
// base are deliberately not replayed, and these cases are about payload
// interpretation rather than clock ordering.
const entry = (type: string, source: string, payload?: unknown, timestamp = 1001): TimelineEntry =>
  ({ timestamp, type, detail: source, source, payload }) as TimelineEntry;

const base: TimeTravelBase = {
  signals: [
    { label: 'count', value: 0, subscriberCount: 1 },
    { label: 'name', value: 'ada', subscriberCount: 0 },
  ],
  stores: [{ id: 'cart', state: { items: 0, open: false } }],
  capturedAt: 1000,
};

describe('payload extraction', () => {
  test.each([
    [{ value: 5 }, 5],
    [{ next: 6 }, 6],
    [{ to: 7 }, 7],
    [8, 8],
    ['done', 'done'],
    [{ unrelated: 1 }, { unrelated: 1 }],
  ])('reads %p as %p', (payload, expected) => {
    expect(extractSignalValue(entry('signal:update', 'count', payload))).toEqual(expected);
  });

  test('an absent payload is not guessed', () => {
    expect(extractSignalValue(entry('signal:update', 'count'))).toBe(UNKNOWN_VALUE);
  });

  test('store patches are read from patch/state/next or the payload itself', () => {
    expect(extractStorePatch(entry('store:patch', 'cart', { patch: { items: 2 } }))).toEqual({
      items: 2,
    });
    expect(extractStorePatch(entry('store:patch', 'cart', { state: { items: 3 } }))).toEqual({
      items: 3,
    });
    expect(extractStorePatch(entry('store:patch', 'cart', { items: 4 }))).toEqual({ items: 4 });
    expect(extractStorePatch(entry('store:patch', 'cart', 'nope'))).toBeUndefined();
  });

  test('only state-changing events replay', () => {
    expect(isReplayable(entry('signal:update', 'a'))).toBe(true);
    expect(isReplayable(entry('store:action', 'a'))).toBe(true);
    expect(isReplayable(entry('component:mount', 'a'))).toBe(false);
    expect(isReplayable(entry('measure', 'a'))).toBe(false);
  });
});

describe('reconstructAt', () => {
  const entries = [
    entry('signal:update', 'count', { value: 1 }, 1001),
    entry('component:mount', 'my-app', undefined, 1002),
    entry('store:patch', 'cart', { patch: { items: 2 } }, 1003),
    entry('signal:update', 'count', { value: 2 }, 1004),
  ];

  test('index -1 yields the untouched base state', () => {
    const result = reconstructAt(base, entries, -1);
    expect(result.index).toBe(-1);
    expect(result.timestamp).toBe(1000);
    expect(result.appliedCount).toBe(0);
    expect(result.signals.find(item => item.label === 'count')?.value).toBe(0);
    expect(result.signals.every(item => item.fromBase)).toBe(true);
  });

  test('replays signals and stores up to the given index', () => {
    const result = reconstructAt(base, entries, 2);
    expect(result.timestamp).toBe(1003);
    expect(result.signals.find(item => item.label === 'count')).toMatchObject({
      value: 1,
      fromBase: false,
      unresolved: false,
    });
    // Untouched entries stay flagged as base state.
    expect(result.signals.find(item => item.label === 'name')?.fromBase).toBe(true);
    // Patches merge onto the base state instead of replacing it.
    expect(result.stores[0]?.state).toEqual({ items: 2, open: false });
    expect(result.appliedCount).toBe(2);
  });

  test('replaying further advances the value', () => {
    expect(
      reconstructAt(base, entries, 3).signals.find(item => item.label === 'count')?.value
    ).toBe(2);
  });

  test('an index past the end is clamped', () => {
    expect(reconstructAt(base, entries, 99).index).toBe(entries.length - 1);
  });

  test('signals the page never mentioned in the base still appear', () => {
    const result = reconstructAt(base, [entry('signal:create', 'fresh', { value: 'new' })], 0);
    expect(result.signals.find(item => item.label === 'fresh')?.value).toBe('new');
  });

  test('unrecorded payloads are reported, never invented', () => {
    const result = reconstructAt(base, [entry('signal:update', 'count')], 0);
    const count = result.signals.find(item => item.label === 'count');
    expect(count?.unresolved).toBe(true);
    // The last known value is kept rather than replaced with a guess.
    expect(count?.value).toBe(0);
    expect(result.unresolvedCount).toBe(1);
    expect(result.appliedCount).toBe(0);
  });

  test('an unusable store payload marks the store unresolved', () => {
    const result = reconstructAt(base, [entry('store:patch', 'cart', 'garbage')], 0);
    expect(result.stores[0]).toMatchObject({ id: 'cart', unresolved: true });
    expect(result.stores[0]?.state).toEqual({ items: 0, open: false });
  });

  test('entries recorded before the base snapshot are not replayed', () => {
    // The page's own timeline reaches back before the snapshot was taken.
    // Replaying those would write a known-stale value over a measured one.
    const stale = entry('signal:update', 'count', { value: 999 }, base.capturedAt - 1);
    const result = reconstructAt(base, [stale], 0);
    expect(result.signals.find(item => item.label === 'count')?.value).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.appliedCount).toBe(0);
  });

  test('an entry exactly at the base timestamp still replays', () => {
    const boundary = entry('signal:update', 'count', { value: 7 }, base.capturedAt);
    const result = reconstructAt(base, [boundary], 0);
    expect(result.signals.find(item => item.label === 'count')?.value).toBe(7);
    expect(result.skippedCount).toBe(0);
  });

  test('entries without a source or detail key are skipped', () => {
    const orphan = { timestamp: 1, type: 'signal:update', detail: '' } as TimelineEntry;
    expect(reconstructAt(base, [orphan], 0).appliedCount).toBe(0);
  });

  test('output is sorted for a stable UI', () => {
    const result = reconstructAt(base, entries, 3);
    expect(result.signals.map(item => item.label)).toEqual(['count', 'name']);
  });
});
