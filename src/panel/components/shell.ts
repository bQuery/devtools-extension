/**
 * `<bq-panel>` — the panel shell: status bar plus tabbed views.
 *
 * Tabs whose capability the page did not advertise stay visible but are
 * marked unsupported, so the user can tell "the app has no stores" apart from
 * "this panel cannot show stores".
 *
 * @module panel/components/shell
 */
import { el, replaceChildren } from '../dom';
import type { BridgeCapability } from '../../protocol/messages';
import { defineElement, PanelElement } from './base';
// Side-effect imports: each module registers its custom element on load, and
// the classes below are referenced only as types — without these the elements
// would never be defined.
import './componentTree';
import './inspector';
import './statusBar';
import './timelineView';
import './valueView';
import type { InspectorView } from './inspector';
import type { StatusBar } from './statusBar';

interface TabDefinition {
  readonly id: string;
  readonly label: string;
  readonly capability: BridgeCapability;
  readonly create: () => HTMLElement;
}

const TABS: readonly TabDefinition[] = [
  {
    id: 'components',
    label: 'Components',
    capability: 'components',
    create: () => document.createElement('bq-component-tree'),
  },
  {
    id: 'signals',
    label: 'Signals',
    capability: 'signals',
    create: () => {
      const view = document.createElement('bq-inspector') as InspectorView;
      view.kind = 'signals';
      return view;
    },
  },
  {
    id: 'stores',
    label: 'Stores',
    capability: 'stores',
    create: () => {
      const view = document.createElement('bq-inspector') as InspectorView;
      view.kind = 'stores';
      return view;
    },
  },
  {
    id: 'timeline',
    label: 'Timeline',
    capability: 'timeline',
    create: () => document.createElement('bq-timeline'),
  },
];

/** Panel shell. */
export class PanelShell extends PanelElement {
  /** Injected by the entry point; forwarded to the status bar. */
  public onUpgrade: (() => Promise<void>) | null = null;
  /** Injected by the entry point; forwarded to the status bar. */
  public streaming = false;

  private activeTab = 'components';

  protected render(): void {
    const state = this.state;
    const capabilities = state.bridge.capabilities.value;

    const statusBar = document.createElement('bq-status-bar') as StatusBar;
    statusBar.onUpgrade = this.onUpgrade;
    statusBar.streaming = this.streaming;

    const tabs = el(
      'div',
      { class: 'tabs', attrs: { role: 'tablist' } },
      TABS.map(tab => {
        const supported = capabilities.size === 0 || capabilities.has(tab.capability);
        return el('button', {
          class: `tab${tab.id === this.activeTab ? ' is-active' : ''}${supported ? '' : ' is-unsupported'}`,
          text: tab.label,
          attrs: {
            type: 'button',
            role: 'tab',
            'aria-selected': String(tab.id === this.activeTab),
            ...(supported ? {} : { title: `The page does not advertise "${tab.capability}"` }),
          },
          on: {
            click: () => {
              this.activeTab = tab.id;
              this.render();
            },
          },
        });
      })
    );

    const definition = TABS.find(tab => tab.id === this.activeTab) ?? TABS[0];
    const body = el('div', { class: 'tab-body', attrs: { role: 'tabpanel' } });
    if (definition) body.appendChild(definition.create());

    replaceChildren(this, [statusBar, tabs, body]);
  }
}

defineElement('bq-panel', PanelShell);
