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
import { KNOWN_CAPABILITIES } from '../../protocol/messages';
import { defineElement, PanelElement } from './base';

/** Labels for each connection state. */
const STATE_LABEL: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  'waiting-for-page': 'Waiting for the page',
  connected: 'Connected',
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
    const capabilities = state.bridge.capabilities.value;
    const detail = state.bridge.detail.value;
    const error = state.lastError.value;

    const badges = KNOWN_CAPABILITIES.map(capability =>
      el('span', {
        class: `badge${capabilities.has(capability) ? ' is-on' : ' is-off'}`,
        text: capability,
        title: capabilities.has(capability)
          ? `The page supports "${capability}"`
          : `The page did not advertise "${capability}"`,
      })
    );

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
      el('span', { class: 'spacer' }),
    ];

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
            void state.refreshAll();
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
