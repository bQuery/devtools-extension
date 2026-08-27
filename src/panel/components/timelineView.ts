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
import { emptyMessage } from '../features';
import { collectTypes, filterEntries, MAX_BUFFER_SIZE, MIN_BUFFER_SIZE } from '../timeline';
import { defineElement, PanelElement } from './base';
// Registers <bq-value>, which the rows below instantiate.
import './valueView';
import type { ValueView } from './valueView';

/** Most rows rendered at once; the buffer itself may hold far more. */
const MAX_RENDERED_ROWS = 300;

interface TimelineChrome {
  readonly toolbarHost: HTMLElement;
  readonly searchInput: HTMLInputElement;
  readonly chipsHost: HTMLElement;
  readonly range: HTMLInputElement;
  readonly liveButton: HTMLButtonElement;
  readonly scrubberStatus: HTMLElement;
  readonly listHost: HTMLElement;
}

/** Timeline view. */
export class TimelineView extends PanelElement {
  private expandedRow = -1;
  private chrome: TimelineChrome | null = null;

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

    this.buildChrome();
    const chrome = this.chrome;
    if (!chrome) return;

    replaceChildren(chrome.toolbarHost, [this.toolbar(paused, entries.length)]);
    this.updateFilters(entries, filter);
    this.updateScrubber(entries.length, travelIndex);
    replaceChildren(chrome.listHost, [this.list(rendered, entries, visible.length)]);
  }

  /**
   * Build the parts that must survive a re-render.
   *
   * `render()` reads the very signals these controls write, so rebuilding them
   * would detach whatever the user is interacting with: the search field loses
   * its caret after one keystroke, and the scrubber's drag ends the moment it
   * moves. Their containers are created once and only their contents change.
   */
  private buildChrome(): void {
    if (this.chrome) return;
    const state = this.state;

    const toolbarHost = el('div');
    const searchInput = el('input', {
      class: 'tree-search',
      attrs: {
        type: 'search',
        placeholder: 'Filter events…',
        'aria-label': 'Filter timeline events',
      },
      on: {
        input: event => {
          const target = event.target as HTMLInputElement;
          const current = state.timelineFilter.value;
          state.timelineFilter.value = { types: current.types, search: target.value };
        },
      },
    });
    const chipsHost = el('div', { class: 'chips' });
    const range = el('input', {
      class: 'scrubber-range',
      attrs: { type: 'range', min: '0', 'aria-label': 'Replay position' },
      on: {
        input: event => {
          const target = event.target as HTMLInputElement;
          state.travelTo(Number(target.value));
        },
      },
    });
    const liveButton = el('button', {
      class: 'btn',
      text: 'Live',
      attrs: { type: 'button' },
      on: { click: () => state.resumeLive() },
    });
    const scrubberStatus = el('span', { class: 'muted' });
    const listHost = el('div');

    const filtersRow = el('div', { class: 'timeline-filters' }, [searchInput, chipsHost]);
    const scrubberRow = el('div', { class: 'scrubber' }, [
      el('label', { class: 'field scrubber-field' }, [el('span', { text: 'Time travel' }), range]),
      liveButton,
      scrubberStatus,
    ]);

    this.chrome = {
      toolbarHost,
      searchInput,
      chipsHost,
      range,
      liveButton,
      scrubberStatus,
      listHost,
    };
    replaceChildren(this, [toolbarHost, filtersRow, scrubberRow, listHost]);
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

  private updateFilters(
    entries: readonly TimelineEntry[],
    filter: { types: ReadonlySet<string>; search: string }
  ): void {
    const state = this.state;
    const chrome = this.chrome;
    if (!chrome) return;
    const types = collectTypes(entries);

    if (chrome.searchInput.value !== filter.search) chrome.searchInput.value = filter.search;

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

    replaceChildren(chrome.chipsHost, chips);
  }

  private updateScrubber(total: number, travelIndex: number | null): void {
    const state = this.state;
    const chrome = this.chrome;
    if (!chrome) return;
    const supported = state.canTimeTravel();
    const disabled = total === 0 || !supported;
    const index = travelIndex ?? total - 1;
    const replay = state.reconstruction.value;

    const { range, liveButton, scrubberStatus } = chrome;
    range.max = String(Math.max(total - 1, 0));
    // Leave the thumb alone while it is being dragged, or the value written
    // back mid-gesture fights the pointer.
    if (document.activeElement !== range) range.value = String(Math.max(index, 0));
    range.disabled = disabled;
    liveButton.disabled = travelIndex === null;
    scrubberStatus.textContent = !supported
      ? total === 0
        ? 'Nothing recorded yet to replay.'
        : 'No snapshot to replay onto: this page reports neither signals nor stores.'
      : replay
        ? `@ ${formatTime(replay.timestamp)} · ${replay.appliedCount} applied${
            replay.unresolvedCount > 0 ? ` · ${replay.unresolvedCount} not recorded` : ''
          }`
        : 'Following live state';
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
          text: emptyMessage(
            state.feature('timeline'),
            'a timeline',
            'No events recorded yet. Interact with the page to see reactive activity.'
          ),
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
        if (bufferIndex >= 0 && state.canTimeTravel()) {
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
