/**
 * `<bq-panel>` — the panel shell: status bar plus tabbed views.
 *
 * Every tab stays visible and reachable. One whose section the page has
 * *proved* it cannot serve is marked unsupported, so the user can tell "the
 * app has no stores" apart from "this page cannot report stores" — a
 * distinction that matters when only part of bQuery is loaded.
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

    const statusBar = document.createElement('bq-status-bar') as StatusBar;
    statusBar.onUpgrade = this.onUpgrade;
    statusBar.streaming = this.streaming;

    const tabs = el(
      'div',
      { class: 'tabs', attrs: { role: 'tablist' } },
      TABS.map(tab => {
        // Only a proven-unavailable section is marked: a capability the page
        // did not advertise may still answer, so it is not written off before
        // it has been tried.
        const feature = state.feature(tab.capability);
        const supported = feature.status !== 'unsupported';
        return el('button', {
          class: `tab${tab.id === this.activeTab ? ' is-active' : ''}${supported ? '' : ' is-unsupported'}`,
          text: tab.label,
          attrs: {
            type: 'button',
            role: 'tab',
            'aria-selected': String(tab.id === this.activeTab),
            ...(supported
              ? {}
              : { title: `This page cannot serve "${tab.capability}": ${feature.detail}` }),
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
