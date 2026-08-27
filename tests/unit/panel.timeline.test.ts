import { describe, expect, test } from 'bun:test';
import type { TimelineEntry } from '../../src/protocol/messages';
import {
  clampBufferSize,
  collectTypes,
  DEFAULT_BUFFER_SIZE,
  filterEntries,
  MAX_BUFFER_SIZE,
  MIN_BUFFER_SIZE,
  TimelineBuffer,
} from '../../src/panel/timeline';

const entry = (type: string, detail = '', source?: string): TimelineEntry =>
  ({ timestamp: 0, type, detail, ...(source ? { source } : {}) }) as TimelineEntry;

describe('clampBufferSize', () => {
  test.each([
    [10, MIN_BUFFER_SIZE],
    [999999, MAX_BUFFER_SIZE],
    [500, 500],
    [500.7, 500],
    ['nonsense', DEFAULT_BUFFER_SIZE],
    [Number.NaN, DEFAULT_BUFFER_SIZE],
  ])('clamps %p to %p', (input, expected) => {
    expect(clampBufferSize(input)).toBe(expected as number);
  });
});

describe('TimelineBuffer', () => {
  test('evicts the oldest entries when full and counts the drops', () => {
    const buffer = new TimelineBuffer(MIN_BUFFER_SIZE);
    for (let index = 0; index < MIN_BUFFER_SIZE + 5; index += 1) {
      buffer.push(entry('signal:update', `#${index}`));
    }
    expect(buffer.size).toBe(MIN_BUFFER_SIZE);
    expect(buffer.dropped).toBe(5);
    expect(buffer.all()[0]?.detail).toBe('#5');
    expect(buffer.all().at(-1)?.detail).toBe(`#${MIN_BUFFER_SIZE + 4}`);
  });

  test('shrinking the capacity trims immediately', () => {
    const buffer = new TimelineBuffer(200);
    buffer.extend(Array.from({ length: 120 }, (_, index) => entry('mark', `#${index}`)));
    buffer.resize(60);
    expect(buffer.size).toBe(60);
    expect(buffer.capacity).toBe(60);
    expect(buffer.all()[0]?.detail).toBe('#60');
  });

  test('growing the capacity keeps what is there', () => {
    const buffer = new TimelineBuffer(MIN_BUFFER_SIZE);
    buffer.extend(Array.from({ length: 20 }, () => entry('mark')));
    buffer.resize(500);
    expect(buffer.size).toBe(20);
  });

  test('reset replaces the contents and clears the drop counter', () => {
    const buffer = new TimelineBuffer(MIN_BUFFER_SIZE);
    buffer.extend(Array.from({ length: MIN_BUFFER_SIZE + 10 }, () => entry('mark')));
    expect(buffer.dropped).toBeGreaterThan(0);
    buffer.reset([entry('signal:create', 'seed')]);
    expect(buffer.size).toBe(1);
    expect(buffer.dropped).toBe(0);
  });

  test('clear empties the buffer', () => {
    const buffer = new TimelineBuffer();
    buffer.push(entry('mark'));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.all()).toEqual([]);
  });
});

describe('filterEntries', () => {
  const entries = [
    entry('signal:update', 'count → 2', 'count'),
    entry('store:patch', 'cart items', 'cart'),
    entry('component:mount', '<my-app>'),
  ];

  test('an empty filter keeps everything', () => {
    expect(filterEntries(entries, { types: new Set(), search: '' })).toHaveLength(3);
  });

  test('filters by type', () => {
    const filtered = filterEntries(entries, { types: new Set(['store:patch']), search: '' });
    expect(filtered.map(item => item.type)).toEqual(['store:patch']);
  });

  test('searches type, detail and source case-insensitively', () => {
    expect(filterEntries(entries, { types: new Set(), search: 'CART' })).toHaveLength(1);
    expect(filterEntries(entries, { types: new Set(), search: 'my-app' })).toHaveLength(1);
    expect(filterEntries(entries, { types: new Set(), search: 'signal' })).toHaveLength(1);
  });

  test('type and search compose', () => {
    expect(
      filterEntries(entries, { types: new Set(['signal:update']), search: 'cart' })
    ).toHaveLength(0);
  });
});

describe('collectTypes', () => {
  test('returns each type once, sorted', () => {
    expect(collectTypes([entry('mark'), entry('signal:update'), entry('mark')])).toEqual([
      'mark',
      'signal:update',
    ]);
  });
});
