/**
 * Component-tree helpers: search/filter and in-page selection.
 *
 * Nodes are addressed by their **structural path** — the chain of indices
 * into the serialized tree (`[2, 0, 1]` = third root, first child, second
 * grandchild). The `id` the framework assigns is derived from DOM child
 * indices and is not unique across sibling subtrees, so it cannot be used to
 * address a node; the structural path always can.
 *
 * @module panel/tree
 */
import type { ComponentTreeNode } from '../protocol/messages';

/** A node together with the path that addresses it. */
export interface FlatTreeNode {
  readonly node: ComponentTreeNode;
  readonly path: readonly number[];
  readonly depth: number;
  /** `true` when this node matched the active search itself. */
  readonly matched: boolean;
}

/** Serialize a path for use as a DOM id / dataset value. */
export const pathKey = (path: readonly number[]): string => path.join('.');

/** Parse a path previously produced by {@link pathKey}. */
export const parsePathKey = (key: string): number[] =>
  key
    .split('.')
    .filter(part => part !== '')
    .map(part => Number.parseInt(part, 10))
    .filter(part => Number.isInteger(part) && part >= 0);

const nodeMatches = (node: ComponentTreeNode, needle: string): boolean => {
  if (node.tag.includes(needle)) return true;
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name.toLowerCase().includes(needle) || value.toLowerCase().includes(needle)) return true;
  }
  return false;
};

/**
 * Flatten the tree for rendering, applying an optional search.
 *
 * A node survives the search when it matches itself or has a matching
 * descendant, so matches stay reachable through their ancestors.
 */
export const flattenTree = (nodes: readonly ComponentTreeNode[], search = ''): FlatTreeNode[] => {
  const needle = search.trim().toLowerCase();
  const out: FlatTreeNode[] = [];

  const visit = (node: ComponentTreeNode, path: number[], depth: number): boolean => {
    const selfMatch = needle === '' || nodeMatches(node, needle);
    const start = out.length;
    // Reserve this node's slot; it is dropped again if nothing below matched.
    out.push({ node, path: [...path], depth, matched: needle !== '' && selfMatch });

    let childMatch = false;
    node.children.forEach((child, index) => {
      if (visit(child, [...path, index], depth + 1)) childMatch = true;
    });

    if (needle !== '' && !selfMatch && !childMatch) {
      out.length = start;
      return false;
    }
    return true;
  };

  nodes.forEach((node, index) => visit(node, [index], 0));
  return out;
};

/** Look up a node by its structural path. */
export const nodeAtPath = (
  nodes: readonly ComponentTreeNode[],
  path: readonly number[]
): ComponentTreeNode | null => {
  let current: ComponentTreeNode | undefined;
  let level: readonly ComponentTreeNode[] = nodes;
  for (const index of path) {
    current = level[index];
    if (!current) return null;
    level = current.children;
  }
  return current ?? null;
};

/**
 * Build the expression that selects a node in the page's Elements panel.
 *
 * It re-walks the live DOM with the same rule `serializeComponentTree` uses
 * (custom elements only, non-custom elements flattened away), follows the
 * structural path, then scrolls the element into view and hands it to
 * DevTools' `inspect()`.
 *
 * @returns The expression, or `null` for a malformed path.
 */
export const buildSelectExpression = (path: readonly number[]): string | null => {
  if (path.length === 0) return null;
  if (!path.every(index => Number.isInteger(index) && index >= 0)) return null;
  const literal = JSON.stringify(path);
  return `(function () {
  function collect(parent) {
    var out = [];
    var children = parent.children;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var nested = collect(child);
      if (child.tagName.indexOf('-') !== -1) out.push({ el: child, children: nested });
      else out.push.apply(out, nested);
    }
    return out;
  }
  var path = ${literal};
  var level = document.body ? collect(document.body) : [];
  var node = null;
  for (var i = 0; i < path.length; i++) {
    node = level[path[i]];
    if (!node) return null;
    level = node.children;
  }
  if (!node) return null;
  try {
    node.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch (error) {
    /* scrollIntoView options are optional in older engines */
  }
  if (typeof inspect === 'function') inspect(node.el);
  return node.el.tagName.toLowerCase();
})()`;
};
