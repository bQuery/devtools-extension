/**
 * `<bq-timeline>` — reactive event log, buffering controls and time travel.
 *
 * The scrubber addresses buffered entries by index; moving it pauses live
 * streaming and asks {@link PanelState} for the reconstruction at that point,
 * which the signals and stores views pick up automatically.
 *
 * @module panel/components/timelineView
 */
import type { TimelineEntry } from '../../protocol/messages';
import { el, formatTime, replaceChildren } from '../dom';
import { collectTypes, filterEntries, MAX_BUFFER_SIZE, MIN_BUFFER_SIZE } from '../timeline';
import { defineElement, PanelElement } from './base';
// Registers <bq-value>, which the rows below instantiate.
import './valueView';
import type { ValueView } from './valueView';

/** Most rows rendered at once; the buffer itself may hold far more. */
const MAX_RENDERED_ROWS = 300;

/** Timeline view. */
export class TimelineView extends PanelElement {
  private expandedRow = -1;

  protected render(): void {
    const state = this.state;
    // Read the revision so the effect re-runs whenever the buffer changes.
    void state.timelineRevision.value;
    const filter = state.timelineFilter.value;
    const paused = state.paused.value;
    const travelIndex = state.timeTravelIndex.value;
    const entries = state.entries();
    const visible = filterEntries(entries, filter);
    const rendered = visible.slice(-MAX_RENDERED_ROWS);

    replaceChildren(this, [
      this.toolbar(paused, entries.length),
      this.filters(entries, filter),
      this.scrubber(entries.length, travelIndex),
      this.list(rendered, entries, visible.length),
    ]);
  }

  private toolbar(paused: boolean, bufferedCount: number): Node {
    const state = this.state;
    const dropped = state.droppedEntries();
    return el('div', { class: 'view-toolbar' }, [
      el('button', {
        class: `btn${paused ? ' is-active' : ''}`,
        text: paused ? 'Resume' : 'Pause',
        attrs: { type: 'button' },
        on: {
          click: () => {
            if (state.timeTravelIndex.value !== null) state.resumeLive();
            else state.paused.value = !state.paused.value;
          },
        },
      }),
      el('button', {
        class: 'btn',
        text: 'Clear',
        attrs: { type: 'button' },
        on: { click: () => state.clearTimeline() },
      }),
      el('label', { class: 'field' }, [
        el('span', { text: 'Buffer' }),
        el('input', {
          class: 'buffer-input',
          attrs: {
            type: 'number',
            min: String(MIN_BUFFER_SIZE),
            max: String(MAX_BUFFER_SIZE),
            step: '50',
            value: String(state.bufferCapacity()),
            'aria-label': 'Timeline buffer size',
          },
          on: {
            change: event => {
              const target = event.target as HTMLInputElement;
              state.setBufferSize(Number(target.value));
            },
          },
        }),
      ]),
      el('span', {
        class: 'muted',
        text: `${bufferedCount} buffered${dropped > 0 ? ` · ${dropped} dropped` : ''}`,
      }),
    ]);
  }

  private filters(
    entries: readonly TimelineEntry[],
    filter: { types: ReadonlySet<string>; search: string }
  ): Node {
    const state = this.state;
    const types = collectTypes(entries);

    const chips = types.map(type =>
      el('button', {
        class: `chip${filter.types.has(type) ? ' is-on' : ''}`,
        text: type,
        attrs: { type: 'button', 'aria-pressed': String(filter.types.has(type)) },
        on: {
          click: () => {
            const next = new Set(filter.types);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            state.timelineFilter.value = { types: next, search: filter.search };
          },
        },
      })
    );

    return el('div', { class: 'timeline-filters' }, [
      el('input', {
        class: 'tree-search',
        attrs: {
          type: 'search',
          placeholder: 'Filter events…',
          value: filter.search,
          'aria-label': 'Filter timeline events',
        },
        on: {
          input: event => {
            const target = event.target as HTMLInputElement;
            state.timelineFilter.value = { types: filter.types, search: target.value };
          },
        },
      }),
      el('div', { class: 'chips' }, chips),
    ]);
  }

  private scrubber(total: number, travelIndex: number | null): Node {
    const state = this.state;
    const supported = state.supports('time-travel');
    const disabled = total === 0 || !supported;
    const index = travelIndex ?? total - 1;
    const replay = state.reconstruction.value;

    return el('div', { class: 'scrubber' }, [
      el('label', { class: 'field scrubber-field' }, [
        el('span', { text: 'Time travel' }),
        el('input', {
          class: 'scrubber-range',
          attrs: {
            type: 'range',
            min: '0',
            max: String(Math.max(total - 1, 0)),
            value: String(Math.max(index, 0)),
            'aria-label': 'Replay position',
            ...(disabled ? { disabled: 'true' } : {}),
          },
          on: {
            input: event => {
              const target = event.target as HTMLInputElement;
              state.travelTo(Number(target.value));
            },
          },
        }),
      ]),
      el('button', {
        class: 'btn',
        text: 'Live',
        attrs: { type: 'button', ...(travelIndex === null ? { disabled: 'true' } : {}) },
        on: { click: () => state.resumeLive() },
      }),
      el('span', {
        class: 'muted',
        text: !supported
          ? 'The page does not advertise the "time-travel" capability.'
          : replay
            ? `@ ${formatTime(replay.timestamp)} · ${replay.appliedCount} applied${
                replay.unresolvedCount > 0 ? ` · ${replay.unresolvedCount} not recorded` : ''
              }`
            : 'Following live state',
      }),
    ]);
  }

  private list(
    rendered: readonly TimelineEntry[],
    all: readonly TimelineEntry[],
    visibleCount: number
  ): Node {
    const state = this.state;
    const travelIndex = state.timeTravelIndex.value;
    // One pass to address buffered entries by identity, instead of an
    // `indexOf` scan per rendered row.
    const bufferIndexOf = new Map<TimelineEntry, number>();
    all.forEach((entry, index) => bufferIndexOf.set(entry, index));
    const list = el('div', { class: 'timeline-list' });

    if (rendered.length === 0) {
      list.appendChild(
        el('p', {
          class: 'empty',
          text: state.supports('timeline')
            ? 'No events recorded yet. Interact with the page to see reactive activity.'
            : 'The page does not advertise the "timeline" capability.',
        })
      );
      return list;
    }

    if (visibleCount > rendered.length) {
      list.appendChild(
        el('p', {
          class: 'muted',
          text: `Showing the ${rendered.length} most recent of ${visibleCount} matching events.`,
        })
      );
    }

    // Newest first reads better in a log, but indices address the buffer.
    for (let offset = rendered.length - 1; offset >= 0; offset -= 1) {
      const entry = rendered[offset];
      if (!entry) continue;
      const bufferIndex = bufferIndexOf.get(entry) ?? -1;
      const isCurrent = travelIndex !== null && bufferIndex === travelIndex;
      const expanded = this.expandedRow === bufferIndex;

      const row = el('div', {
        class: `timeline-row${isCurrent ? ' is-current' : ''}`,
      });
      row.appendChild(
        el(
          'button',
          {
            class: 'timeline-head',
            attrs: { type: 'button', 'aria-expanded': String(expanded) },
            on: {
              click: () => {
                this.expandedRow = expanded ? -1 : bufferIndex;
                this.render();
              },
            },
          },
          [
            el('span', { class: 'timeline-time', text: formatTime(entry.timestamp) }),
            el('span', {
              class: `timeline-type type-${entry.type.split(':')[0] ?? 'other'}`,
              text: entry.type,
            }),
            el('span', { class: 'timeline-detail', text: entry.detail }),
            entry.source ? el('span', { class: 'badge', text: entry.source }) : null,
            entry.duration !== undefined
              ? el('span', { class: 'badge', text: `${entry.duration.toFixed(1)}ms` })
              : null,
          ]
        )
      );

      if (expanded) {
        const details = el('div', { class: 'timeline-payload' });
        if (entry.payload === undefined) {
          details.appendChild(el('p', { class: 'muted', text: 'No payload recorded.' }));
        } else {
          const value = document.createElement('bq-value') as ValueView;
          details.appendChild(value);
          value.setValue(entry.payload, 'payload');
        }
        if (bufferIndex >= 0 && state.supports('time-travel')) {
          details.appendChild(
            el('button', {
              class: 'btn',
              text: 'Replay state at this event',
              attrs: { type: 'button' },
              on: { click: () => state.travelTo(bufferIndex) },
            })
          );
        }
        row.appendChild(details);
      }

      list.appendChild(row);
    }

    return list;
  }
}

defineElement('bq-timeline', TimelineView);
