/**
 * `<bq-status-bar>` — connection state, negotiated capabilities, transport.
 *
 * Also hosts the upgrade path to live streaming: the button asks for the
 * inspected origin's permission *on a user gesture* (the only moment a
 * browser will grant one) and then swaps the transport.
 *
 * @module panel/components/statusBar
 */
import { el, replaceChildren } from '../dom';
import { KNOWN_CAPABILITIES, unknownCapabilities } from '../../protocol/messages';
import { featureTitle } from '../features';
import { defineElement, PanelElement } from './base';

/** Labels for each connection state. */
const STATE_LABEL: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  'waiting-for-page': 'Waiting for the page',
  connected: 'Connected',
  incompatible: 'Incompatible protocol',
  disconnected: 'Disconnected',
  error: 'Error',
};

/** Status bar view. */
export class StatusBar extends PanelElement {
  /** Injected by the shell: swap to the live-streaming transport. */
  public onUpgrade: (() => Promise<void>) | null = null;
  /** Injected by the shell: `true` once live streaming is active. */
  public streaming = false;

  protected render(): void {
    const state = this.state;
    const connection = state.bridge.state.value;
    const detail = state.bridge.detail.value;
    const error = state.lastError.value;

    // Badges report what the page *did*, not what it claimed: a capability it
    // advertised but cannot serve reads as off, and one it never advertised
    // but answers anyway reads as on.
    const badges = KNOWN_CAPABILITIES.map(capability => {
      const feature = state.feature(capability);
      const on =
        capability === 'time-travel' ? state.canTimeTravel() : feature.status === 'available';
      return el('span', {
        class: `badge${on ? ' is-on' : feature.status === 'failed' ? ' is-warn' : ' is-off'}`,
        text: capability,
        title: featureTitle(capability, feature),
      });
    });

    const foreign = unknownCapabilities(state.bridge.advertised.value);

    const children: Node[] = [
      el('span', {
        class: `status status-${connection}`,
        text: STATE_LABEL[connection] ?? connection,
      }),
      el('span', { class: 'badge', text: `protocol v1` }),
      el('span', {
        class: 'badge',
        text: this.streaming ? 'live streaming' : 'polling',
        title: this.streaming
          ? 'Events are pushed from the page through a content script.'
          : 'Events are polled through the DevTools evaluation channel (no host permission needed).',
      }),
      ...badges,
    ];

    if (foreign.length > 0) {
      // The page offers something this build has no view for — the visible
      // symptom of an extension older than the app it is inspecting.
      children.push(
        el('span', {
          class: 'badge is-warn',
          text: `+${foreign.length} unknown`,
          title: `This page also advertises ${foreign.join(', ')}, which this version of the extension has no view for.`,
        })
      );
    }

    children.push(el('span', { class: 'spacer' }));

    if (!this.streaming && this.onUpgrade) {
      children.push(
        el('button', {
          class: 'btn',
          text: 'Enable live streaming',
          attrs: {
            type: 'button',
            title:
              'Requests permission for this site and injects a content script so events arrive as they happen.',
          },
          on: {
            click: () => {
              void this.onUpgrade?.();
            },
          },
        })
      );
    }

    children.push(
      el('button', {
        class: 'btn',
        text: state.loading.value ? 'Refreshing…' : 'Refresh all',
        attrs: { type: 'button', ...(state.loading.value ? { disabled: 'true' } : {}) },
        on: {
          click: () => {
            // An explicit refresh re-probes sections previously written off,
            // so enabling devtools (or mounting a store) and pressing Refresh
            // is enough to bring a section back without reopening the panel.
            void state.refreshAll({ retry: true });
          },
        },
      })
    );

    const bar = el('div', { class: 'status-bar' }, children);
    const message = error || (connection !== 'connected' ? detail : '');
    replaceChildren(this, [
      bar,
      message ? el('p', { class: 'status-message', text: message }) : null,
    ]);
  }
}

defineElement('bq-status-bar', StatusBar);
