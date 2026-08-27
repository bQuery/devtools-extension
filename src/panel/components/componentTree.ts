/**
 * `<bq-component-tree>` — searchable component tree with in-page selection.
 *
 * Clicking a node calls DevTools' `inspect()` on the matching element in the
 * page, which reveals it in the Elements panel — the tree is a navigation
 * aid, not just a listing.
 *
 * @module panel/components/componentTree
 */
import { extensionApi, hasExtensionApi } from '../../browser';
import { el, replaceChildren } from '../dom';
import { buildSelectExpression, flattenTree, nodeAtPath, parsePathKey, pathKey } from '../tree';
import { defineElement, PanelElement } from './base';

/** Component tree view. */
export class ComponentTreeView extends PanelElement {
  protected render(): void {
    const state = this.state;
    const search = state.treeSearch.value;
    const nodes = state.tree.value;
    const selected = state.selectedPath.value;
    const flat = flattenTree(nodes, search);

    const searchInput = el('input', {
      class: 'tree-search',
      attrs: {
        type: 'search',
        placeholder: 'Filter by tag or attribute…',
        value: search,
        'aria-label': 'Filter components',
      },
      on: {
        input: event => {
          const target = event.target as HTMLInputElement;
          state.treeSearch.value = target.value;
        },
      },
    });

    const header = el('div', { class: 'view-toolbar' }, [
      searchInput,
      el('span', {
        class: 'muted',
        text: search ? `${flat.length} matching` : `${flat.length} components`,
      }),
      el('button', {
        class: 'btn',
        text: 'Refresh',
        attrs: { type: 'button' },
        on: {
          click: () => {
            void state.refreshTree();
          },
        },
      }),
    ]);

    const list = el('div', { class: 'tree-list', attrs: { role: 'tree' } });
    if (flat.length === 0) {
      list.appendChild(
        el('p', {
          class: 'empty',
          text: state.supports('components')
            ? 'No custom elements found on the page.'
            : 'The page does not advertise the "components" capability.',
        })
      );
    }

    for (const item of flat) {
      const key = pathKey(item.path);
      const row = el('button', {
        class: ['tree-row', item.matched ? 'is-match' : '', key === selected ? 'is-selected' : '']
          .filter(Boolean)
          .join(' '),
        attrs: {
          type: 'button',
          role: 'treeitem',
          'data-path': key,
          'aria-level': String(item.depth + 1),
          title: `Reveal <${item.node.tag}> in the Elements panel`,
        },
        style: { 'padding-left': `${8 + item.depth * 14}px` },
        on: { click: () => void this.selectNode(key) },
      });
      row.appendChild(el('span', { class: 'tree-tag', text: `<${item.node.tag}>` }));
      const attrs = Object.entries(item.node.attrs);
      if (attrs.length > 0) {
        row.appendChild(
          el('span', {
            class: 'tree-attrs',
            text: attrs.map(([name, value]) => (value ? `${name}="${value}"` : name)).join(' '),
          })
        );
      }
      if (item.node.children.length > 0) {
        row.appendChild(el('span', { class: 'tree-count', text: `${item.node.children.length}` }));
      }
      list.appendChild(row);
    }

    replaceChildren(this, [header, list]);
  }

  /** Reveal the node in the page's Elements panel. */
  private async selectNode(key: string): Promise<void> {
    const state = this.state;
    state.selectedPath.value = key;
    const path = parsePathKey(key);
    const node = nodeAtPath(state.tree.value, path);
    const expression = buildSelectExpression(path);
    if (!expression || !node) return;
    if (!hasExtensionApi()) return;
    const devtools = extensionApi().devtools;
    if (!devtools?.inspectedWindow?.eval) return;
    devtools.inspectedWindow.eval(expression, (result: unknown) => {
      if (result === null || result === undefined) {
        state.lastError.value = `Could not locate <${node.tag}> in the page; try refreshing the tree.`;
      } else {
        state.lastError.value = '';
      }
    });
  }
}

defineElement('bq-component-tree', ComponentTreeView);
