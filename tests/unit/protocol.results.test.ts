import { describe, expect, test } from 'bun:test';
import { parseComponentTree, parseSnapshot, parseTimeline } from '../../src/protocol/results';

describe('parseSnapshot', () => {
  test('lifts the timeline out of the nested devtools state', () => {
    const snapshot = parseSnapshot({
      version: 1,
      exportedAt: 1234,
      state: { enabled: true, timeline: [{ type: 'mark', detail: 'boot', timestamp: 1 }] },
      signals: [{ label: 'count', value: 3, subscriberCount: 2 }],
      stores: [{ id: 'cart', state: { items: 1 } }],
      components: [{ tagName: 'my-app', instanceCount: 1 }],
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.exportedAt).toBe(1234);
    expect(snapshot?.signals).toEqual([{ label: 'count', value: 3, subscriberCount: 2 }]);
    expect(snapshot?.stores).toEqual([{ id: 'cart', state: { items: 1 } }]);
    expect(snapshot?.timeline).toHaveLength(1);
  });

  test('drops malformed members instead of rendering them', () => {
    const snapshot = parseSnapshot({
      state: {},
      signals: [null, 'nope', { label: 'ok', value: 1, subscriberCount: 'many' }],
      stores: [{ state: {} }, { id: 'valid', state: 'not-an-object' }],
      components: [{ instanceCount: 3 }, { tagName: 'x-y', instanceCount: 2 }],
    });
    expect(snapshot?.signals).toEqual([{ label: 'ok', value: 1, subscriberCount: 0 }]);
    expect(snapshot?.stores).toEqual([{ id: 'valid', state: {} }]);
    expect(snapshot?.components).toEqual([{ tagName: 'x-y', instanceCount: 2 }]);
  });

  test('returns null for a non-object result', () => {
    expect(parseSnapshot('nope')).toBeNull();
  });
});

describe('parseComponentTree', () => {
  test('keeps string attributes only', () => {
    const { tree } = parseComponentTree({
      tree: [
        {
          tag: 'my-app',
          id: '0',
          attrs: { class: 'root', count: 3 },
          children: [{ tag: 'my-child', id: '0/1', attrs: {}, children: [] }],
        },
        { id: 'no-tag' },
      ],
      flat: [{ tagName: 'my-app', instanceCount: 1 }],
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.attrs).toEqual({ class: 'root' });
    expect(tree[0]?.children[0]?.tag).toBe('my-child');
  });

  test('caps recursion so a self-nested tree cannot blow the stack', () => {
    interface Node {
      tag: string;
      id: string;
      attrs: Record<string, string>;
      children: Node[];
    }
    const root: Node = { tag: 'deep-node', id: '0', attrs: {}, children: [] };
    let cursor = root;
    for (let depth = 0; depth < 500; depth += 1) {
      const child: Node = { tag: 'deep-node', id: String(depth), attrs: {}, children: [] };
      cursor.children.push(child);
      cursor = child;
    }

    const { tree } = parseComponentTree({ tree: [root], flat: [] });
    let depth = 0;
    let node = tree[0];
    while (node && node.children.length > 0) {
      node = node.children[0];
      depth += 1;
    }
    expect(depth).toBeLessThan(500);
    expect(depth).toBeGreaterThan(0);
  });

  test('degrades to empty collections for junk', () => {
    expect(parseComponentTree(null)).toEqual({ tree: [], flat: [] });
  });
});

describe('parseTimeline', () => {
  test('fills in missing fields and drops untyped entries', () => {
    const entries = parseTimeline([{ type: 'mark' }, { detail: 'no type' }, 7]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toBe('');
    expect(typeof entries[0]?.timestamp).toBe('number');
  });
});
