/**
 * Options page — defaults for the DevTools panel.
 *
 * Written with bQuery's reactive forms and `safeHtml` sinks, and persisted
 * through `chrome.storage.local`. Nothing here touches page data; the
 * `storage` permission grants no access to any site.
 *
 * @module settings
 */
import { safeHtml } from '@bquery/bquery/component';
import { $ } from '@bquery/bquery/core';
import { effect } from '@bquery/bquery/reactive';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  normalizeSettings,
  saveSettings,
  type PanelSettings,
} from './panel/settings';
import { MAX_BUFFER_SIZE, MIN_BUFFER_SIZE } from './panel/timeline';
import { signal } from '@bquery/bquery/reactive';
import './sass/panel.sass';

const HOST_ID = 'settings';

const current = signal<PanelSettings>(DEFAULT_SETTINGS);
const status = signal<string>('');

const render = (): void => {
  const host = document.getElementById(HOST_ID);
  if (!host) throw new Error(`bQuery DevTools: #${HOST_ID} is missing from options.html`);

  $(`#${HOST_ID}`)
    .empty()
    .append(
      safeHtml`<form id="settings-form" class="settings-form" novalidate>
      <div class="field-block">
        <label for="bufferSize">Timeline buffer size</label>
        <input type="number" id="bufferSize" min="${String(MIN_BUFFER_SIZE)}" max="${String(MAX_BUFFER_SIZE)}" step="50" />
        <small>How many reactive events the panel keeps. Older entries are dropped first.</small>
      </div>
      <div class="field-block">
        <label for="pollIntervalMs">Poll interval (ms)</label>
        <input type="number" id="pollIntervalMs" min="${String(MIN_POLL_INTERVAL_MS)}" max="${String(MAX_POLL_INTERVAL_MS)}" step="10" />
        <small>How often the permission-free transport drains events from the page.</small>
      </div>
      <div class="field-block field-inline">
        <input type="checkbox" id="preferLiveStreaming" />
        <label for="preferLiveStreaming">Use live streaming when this site is already allowed</label>
        <small>Live streaming pushes events through a content script. It needs per-site permission, which the panel asks for on demand.</small>
      </div>
      <button type="submit" class="btn" id="save">Save</button>
      <p id="settings-status" class="status-message" role="status"></p>
    </form>`
    );

  const bufferInput = document.getElementById('bufferSize') as HTMLInputElement;
  const pollInput = document.getElementById('pollIntervalMs') as HTMLInputElement;
  const streamInput = document.getElementById('preferLiveStreaming') as HTMLInputElement;

  effect(() => {
    const settings = current.value;
    bufferInput.value = String(settings.bufferSize);
    pollInput.value = String(settings.pollIntervalMs);
    streamInput.checked = settings.preferLiveStreaming;
  });

  effect(() => {
    $('#settings-status').text(status.value);
  });

  $('#settings-form').on('submit', event => {
    event.preventDefault();
    const next = normalizeSettings({
      bufferSize: Number(bufferInput.value),
      pollIntervalMs: Number(pollInput.value),
      preferLiveStreaming: streamInput.checked,
    });
    current.value = next;
    void saveSettings(next).then(() => {
      status.value = 'Saved. Reopen the bQuery panel to apply.';
    });
  });
};

void loadSettings().then(settings => {
  current.value = settings;
  render();
});
