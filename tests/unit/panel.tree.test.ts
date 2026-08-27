import { describe, expect, test } from 'bun:test';
import type { ComponentTreeNode } from '../../src/protocol/messages';
import {
  buildSelectExpression,
  flattenTree,
  nodeAtPath,
  parsePathKey,
  pathKey,
} from '../../src/panel/tree';

const node = (
  tag: string,
  children: ComponentTreeNode[] = [],
  attrs: Record<string, string> = {}
): ComponentTreeNode => ({ tag, id: tag, attrs, children });

const tree: ComponentTreeNode[] = [
  node('my-app', [
    node('my-header', [], { title: 'Dashboard' }),
    node('my-list', [node('my-item', [], { 'data-id': '1' }), node('my-item')]),
  ]),
  node('my-footer'),
];

describe('path keys', () => {
  test('round-trip', () => {
    expect(parsePathKey(pathKey([0, 1, 2]))).toEqual([0, 1, 2]);
  });

  test('junk is discarded', () => {
    expect(parsePathKey('')).toEqual([]);
    expect(parsePathKey('0..x.-1.2')).toEqual([0, 2]);
  });
});

describe('flattenTree', () => {
  test('walks depth-first and records depth and path', () => {
    const flat = flattenTree(tree);
    expect(flat.map(item => item.node.tag)).toEqual([
      'my-app',
      'my-header',
      'my-list',
      'my-item',
      'my-item',
      'my-footer',
    ]);
    expect(flat[3]).toMatchObject({ depth: 2, path: [0, 1, 0] });
    expect(flat.every(item => item.matched === false)).toBe(true);
  });

  test('a search keeps matches and their ancestors', () => {
    const flat = flattenTree(tree, 'item');
    expect(flat.map(item => item.node.tag)).toEqual(['my-app', 'my-list', 'my-item', 'my-item']);
    expect(flat.filter(item => item.matched).map(item => item.node.tag)).toEqual([
      'my-item',
      'my-item',
    ]);
  });

  test('search matches attribute names and values', () => {
    expect(flattenTree(tree, 'dashboard').map(item => item.node.tag)).toEqual([
      'my-app',
      'my-header',
    ]);
    expect(flattenTree(tree, 'data-id').map(item => item.node.tag)).toEqual([
      'my-app',
      'my-list',
      'my-item',
    ]);
  });

  test('a search with no hits yields nothing', () => {
    expect(flattenTree(tree, 'zzz')).toEqual([]);
  });

  test('whitespace-only searches are treated as empty', () => {
    expect(flattenTree(tree, '   ')).toHaveLength(6);
  });
});

describe('nodeAtPath', () => {
  test('resolves a nested path', () => {
    expect(nodeAtPath(tree, [0, 1, 1])?.tag).toBe('my-item');
    expect(nodeAtPath(tree, [1])?.tag).toBe('my-footer');
  });

  test('returns null for a path that does not exist', () => {
    expect(nodeAtPath(tree, [5])).toBeNull();
    expect(nodeAtPath(tree, [0, 9, 0])).toBeNull();
  });
});

describe('buildSelectExpression', () => {
  test('refuses malformed paths', () => {
    expect(buildSelectExpression([])).toBeNull();
    expect(buildSelectExpression([-1])).toBeNull();
    expect(buildSelectExpression([1.5])).toBeNull();
  });

  test('embeds the path as a literal', () => {
    expect(buildSelectExpression([0, 1, 2])).toContain('var path = [0,1,2];');
  });

  test('produces a syntactically valid expression', () => {
    const expression = buildSelectExpression([0]);
    expect(expression).not.toBeNull();
    expect(() => new Function(`return ${expression as string};`)).not.toThrow();
  });

  test('the generated walker mirrors the framework serialization', () => {
    // Reproduce `serializeComponentTree`'s rule: custom elements become nodes,
    // plain elements are flattened away. The generated source is executed
    // against a minimal fake DOM to prove the panel and the page agree.
    interface FakeElement {
      tagName: string;
      children: FakeElement[];
      scrollIntoView(): void;
    }
    const make = (tagName: string, children: FakeElement[] = []): FakeElement => ({
      tagName: tagName.toUpperCase(),
      children,
      scrollIntoView: () => undefined,
    });

    const target = make('my-item');
    const body = make('body', [
      make('div', [make('my-app', [make('span', [make('my-header')]), make('my-list', [target])])]),
    ]);

    const inspected: FakeElement[] = [];
    const expression = buildSelectExpression([0, 1, 0]) as string;
    const run = new Function('document', 'inspect', `return ${expression};`) as (
      doc: { body: FakeElement },
      inspect: (el: FakeElement) => void
    ) => string | null;

    const result = run({ body }, element => inspected.push(element));
    expect(result).toBe('my-item');
    expect(inspected).toEqual([target]);
  });

  test('an out-of-range path resolves to null in the page', () => {
    interface FakeElement {
      tagName: string;
      children: FakeElement[];
      scrollIntoView(): void;
    }
    const body: FakeElement = { tagName: 'BODY', children: [], scrollIntoView: () => undefined };
    const expression = buildSelectExpression([3]) as string;
    const run = new Function('document', 'inspect', `return ${expression};`) as (
      doc: { body: FakeElement },
      inspect: (el: FakeElement) => void
    ) => string | null;
    expect(run({ body }, () => undefined)).toBeNull();
  });
});
