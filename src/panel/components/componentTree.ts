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

/**
 * Component tree view.
 *
 * The toolbar is built once and never re-created. `render()` reads the search
 * signal that the input's own handler writes, so rebuilding the whole subtree
 * would detach the focused field on the first keystroke and silently swallow
 * everything the user typed after it. Only the list below is rebuilt.
 */
export class ComponentTreeView extends PanelElement {
  private searchInput: HTMLInputElement | null = null;
  private countLabel: HTMLElement | null = null;
  private listHost: HTMLElement | null = null;

  private buildChrome(): void {
    if (this.listHost) return;
    const state = this.state;

    this.searchInput = el('input', {
      class: 'tree-search',
      attrs: {
        type: 'search',
        placeholder: 'Filter by tag or attribute…',
        'aria-label': 'Filter components',
      },
      on: {
        input: event => {
          const target = event.target as HTMLInputElement;
          state.treeSearch.value = target.value;
        },
      },
    });
    this.countLabel = el('span', { class: 'muted' });
    this.listHost = el('div', { class: 'tree-list', attrs: { role: 'tree' } });

    const header = el('div', { class: 'view-toolbar' }, [
      this.searchInput,
      this.countLabel,
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

    replaceChildren(this, [header, this.listHost]);
  }

  protected render(): void {
    const state = this.state;
    const search = state.treeSearch.value;
    const nodes = state.tree.value;
    const selected = state.selectedPath.value;
    const flat = flattenTree(nodes, search);

    this.buildChrome();
    const searchInput = this.searchInput;
    const list = this.listHost;
    if (!searchInput || !list || !this.countLabel) return;

    // Only push a value the user did not type themselves, so an in-progress
    // edit (and its caret) is never disturbed.
    if (searchInput.value !== search) searchInput.value = search;
    this.countLabel.textContent = search ? `${flat.length} matching` : `${flat.length} components`;

    const rows: Node[] = [];
    if (flat.length === 0) {
      rows.push(
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
      rows.push(row);
    }

    replaceChildren(list, rows);
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
