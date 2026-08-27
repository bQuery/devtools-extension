import { describe, expect, test } from 'bun:test';
import { UNKNOWN_VALUE } from '../../src/panel/timeTravel';
import {
  describeValue,
  ENTRY_LIMIT,
  isExpandable,
  PREVIEW_LIMIT,
  shortPreview,
} from '../../src/panel/valueTree';

describe('describeValue', () => {
  test.each([
    ['a string', 'hi', 'string', '"hi"'],
    ['a number', 42, 'number', '42'],
    ['a boolean', true, 'boolean', 'true'],
    ['null', null, 'null', 'null'],
    ['undefined', undefined, 'undefined', 'undefined'],
  ])('describes %s', (_label, value, kind, preview) => {
    expect(describeValue(value)).toEqual({ kind: kind as never, preview, entries: null });
  });

  test('primitives are leaves', () => {
    expect(isExpandable('hi')).toBe(false);
    expect(isExpandable({ a: 1 })).toBe(true);
    expect(isExpandable([])).toBe(false);
  });

  test('objects expose their entries', () => {
    const described = describeValue({ a: 1, b: 'two' });
    expect(described.kind).toBe('object');
    expect(described.entries).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 'two' },
    ]);
    expect(described.preview).toBe('{a: 1, b: "two"}');
  });

  test('arrays expose indexed entries', () => {
    const described = describeValue([1, 2, 3]);
    expect(described.kind).toBe('array');
    expect(described.entries).toHaveLength(3);
    expect(described.entries?.[0]).toEqual({ key: '0', value: 1 });
    expect(described.preview).toContain('Array(3)');
  });

  test('previews are length-capped', () => {
    const described = describeValue('x'.repeat(500));
    expect(described.preview.length).toBeLessThanOrEqual(PREVIEW_LIMIT);
    expect(described.preview.endsWith('…')).toBe(true);
  });

  test('entry lists are capped', () => {
    const big = Object.fromEntries(
      Array.from({ length: ENTRY_LIMIT + 50 }, (_, index) => [`k${index}`, index])
    );
    expect(describeValue(big).entries).toHaveLength(ENTRY_LIMIT);
  });

  test('cyclic structures do not hang or throw', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const described = describeValue(cyclic);
    expect(described.kind).toBe('object');
    expect(described.entries?.map(item => item.key)).toEqual(['name', 'self']);
  });

  test('the time-travel unknown marker is labelled, not rendered as a symbol', () => {
    expect(describeValue(UNKNOWN_VALUE)).toEqual({
      kind: 'unknown',
      preview: '(not recorded)',
      entries: null,
    });
  });

  test('functions and symbols degrade gracefully', () => {
    expect(describeValue(() => 1).kind).toBe('function');
    expect(describeValue(Symbol('x')).kind).toBe('unknown');
  });

  test('markup in a value stays data', () => {
    const described = describeValue('<img src=x onerror=alert(1)>');
    expect(described.preview).toBe('"<img src=x onerror=alert(1)>"');
    expect(described.entries).toBeNull();
  });
});

describe('shortPreview', () => {
  test.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [[1, 2], 'Array(2)'],
    [{ a: 1 }, '{…}'],
    [7, '7'],
  ])('previews %p as %p', (value, expected) => {
    expect(shortPreview(value)).toBe(expected as string);
  });

  test('long strings are trimmed hard', () => {
    expect(shortPreview('y'.repeat(100)).length).toBeLessThanOrEqual(24);
  });
});
