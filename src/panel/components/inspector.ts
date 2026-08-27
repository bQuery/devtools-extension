/**
 * `<bq-inspector>` — signals and stores, with drill-down.
 *
 * Reads from the live snapshot, or from the time-travel reconstruction when
 * the timeline scrubber is engaged; in the latter case each row is marked as
 * replayed, unchanged-since-base, or "not recorded" so a reconstructed value
 * is never mistaken for a measured one.
 *
 * @module panel/components/inspector
 */
import { el, replaceChildren } from '../dom';
import { UNKNOWN_VALUE } from '../timeTravel';
import { defineElement, PanelElement } from './base';
// Registers <bq-value>, which the rows below instantiate.
import './valueView';
import type { ValueView } from './valueView';

/** Which collection this inspector shows. */
export type InspectorKind = 'signals' | 'stores';

/** Signals / stores inspector. */
export class InspectorView extends PanelElement {
  /** Set by the panel shell before the element is connected. */
  public kind: InspectorKind = 'signals';

  protected render(): void {
    const state = this.state;
    const replay = state.reconstruction.value;
    const capability = this.kind === 'signals' ? 'signals' : 'stores';

    const rows: Node[] = [];
    if (this.kind === 'signals') {
      const entries = replay
        ? replay.signals.map(item => ({
            key: item.label,
            value: item.value,
            meta: item.unresolved ? 'not recorded' : item.fromBase ? 'unchanged' : 'replayed',
          }))
        : state.signals.value.map(item => ({
            key: item.label,
            value: item.value,
            meta: `${item.subscriberCount} subscriber${item.subscriberCount === 1 ? '' : 's'}`,
          }));
      for (const entry of entries) rows.push(this.row(entry.key, entry.value, entry.meta));
    } else {
      const entries = replay
        ? replay.stores.map(item => ({
            key: item.id,
            value: item.unresolved ? UNKNOWN_VALUE : item.state,
            meta: item.unresolved ? 'not recorded' : item.fromBase ? 'unchanged' : 'replayed',
          }))
        : state.stores.value.map(item => ({
            key: item.id,
            value: item.state as unknown,
            meta: `${Object.keys(item.state).length} keys`,
          }));
      for (const entry of entries) rows.push(this.row(entry.key, entry.value, entry.meta));
    }

    const header = el('div', { class: 'view-toolbar' }, [
      el('span', {
        class: 'muted',
        text: replay
          ? `Replayed state · ${rows.length} ${this.kind}`
          : `${rows.length} ${this.kind}`,
      }),
      el('button', {
        class: 'btn',
        text: 'Refresh',
        attrs: { type: 'button', ...(replay ? { disabled: 'true' } : {}) },
        on: {
          click: () => {
            void state.refreshSnapshot();
          },
        },
      }),
    ]);

    const body = el('div', { class: 'inspector-list' });
    if (rows.length === 0) {
      body.appendChild(
        el('p', {
          class: 'empty',
          text: state.supports(capability)
            ? `No ${this.kind} reported by the page.`
            : `The page does not advertise the "${capability}" capability.`,
        })
      );
    }
    for (const row of rows) body.appendChild(row);

    replaceChildren(this, [header, body]);
  }

  private row(key: string, value: unknown, meta: string): Node {
    const view = document.createElement('bq-value') as ValueView;
    const wrapper = el('div', { class: 'inspector-row' }, [
      el('div', { class: 'inspector-meta' }, [
        el('span', { class: 'inspector-key', text: key }),
        el('span', { class: 'badge', text: meta }),
      ]),
      view,
    ]);
    view.setValue(value);
    return wrapper;
  }
}

defineElement('bq-inspector', InspectorView);
