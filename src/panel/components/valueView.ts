/**
 * `<bq-value>` — expandable view of one signal or store value.
 *
 * Children are described lazily, so a large or deeply nested object costs
 * nothing until the user drills into it.
 *
 * @module panel/components/valueView
 */
import { el, replaceChildren } from '../dom';
import { describeValue, type ValueEntry } from '../valueTree';
import { defineElement } from './base';

/** Expandable value renderer. */
export class ValueView extends HTMLElement {
  private currentValue: unknown = undefined;
  private label = '';
  private expanded = false;
  private depth = 0;

  /** Point the view at a value. */
  public setValue(value: unknown, label = '', depth = 0): void {
    this.currentValue = value;
    this.label = label;
    this.depth = depth;
    this.expanded = false;
    this.render();
  }

  public connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const described = describeValue(this.currentValue);
    const expandable = described.entries !== null && described.entries.length > 0;

    const toggle = el('button', {
      class: `value-toggle${expandable ? '' : ' is-leaf'}`,
      text: expandable ? (this.expanded ? '▾' : '▸') : '•',
      attrs: {
        type: 'button',
        'aria-expanded': String(this.expanded),
        ...(expandable ? {} : { disabled: 'true' }),
      },
      on: expandable
        ? {
            click: () => {
              this.expanded = !this.expanded;
              this.render();
            },
          }
        : {},
    });

    const header = el('div', { class: 'value-row' }, [
      toggle,
      this.label ? el('span', { class: 'value-key', text: this.label }) : null,
      this.label ? el('span', { class: 'value-sep', text: ':' }) : null,
      el('span', { class: `value-preview value-${described.kind}`, text: described.preview }),
    ]);

    const children: Node[] = [header];
    if (expandable && this.expanded && described.entries) {
      const list = el('div', { class: 'value-children' });
      // Depth guard: pathological nesting must not build an unbounded DOM.
      if (this.depth >= 12) {
        list.appendChild(el('div', { class: 'value-note', text: '(max depth reached)' }));
      } else {
        for (const entry of described.entries as readonly ValueEntry[]) {
          const child = document.createElement('bq-value') as ValueView;
          list.appendChild(child);
          child.setValue(entry.value, entry.key, this.depth + 1);
        }
      }
      children.push(list);
    }

    replaceChildren(this, children);
  }
}

defineElement('bq-value', ValueView);
