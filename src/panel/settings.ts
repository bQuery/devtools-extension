/**
 * Persisted panel preferences.
 *
 * Stored with `chrome.storage.local` (the `storage` permission grants no
 * access to page data). Reads never reject: a missing or corrupt record
 * falls back to the defaults so the panel always opens.
 *
 * @module panel/settings
 */
import { hasExtensionApi, extensionApi } from '../browser';
import { clampBufferSize, DEFAULT_BUFFER_SIZE } from './timeline';

/** User-configurable panel preferences. */
export interface PanelSettings {
  /** Timeline ring-buffer capacity. */
  readonly bufferSize: number;
  /** Poll interval of the eval transport, in ms. */
  readonly pollIntervalMs: number;
  /** Try the live-streaming (port) transport when its permission is granted. */
  readonly preferLiveStreaming: boolean;
}

/** Defaults used before anything is stored. */
export const DEFAULT_SETTINGS: PanelSettings = {
  bufferSize: DEFAULT_BUFFER_SIZE,
  pollIntervalMs: 250,
  preferLiveStreaming: false,
};

/** Storage key holding {@link PanelSettings}. */
export const SETTINGS_KEY = 'bquery-devtools.settings';

/** Smallest / largest poll interval offered by the options page. */
export const MIN_POLL_INTERVAL_MS = 50;
export const MAX_POLL_INTERVAL_MS = 5000;

const clampPollInterval = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.pollIntervalMs;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed)));
};

/** Coerce an arbitrary stored record into valid settings. */
export const normalizeSettings = (value: unknown): PanelSettings => {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS;
  const record = value as Record<string, unknown>;
  return {
    bufferSize: clampBufferSize(record['bufferSize'] ?? DEFAULT_SETTINGS.bufferSize),
    pollIntervalMs: clampPollInterval(record['pollIntervalMs'] ?? DEFAULT_SETTINGS.pollIntervalMs),
    preferLiveStreaming: record['preferLiveStreaming'] === true,
  };
};

/** Load the stored settings, falling back to {@link DEFAULT_SETTINGS}. */
export const loadSettings = async (): Promise<PanelSettings> => {
  if (!hasExtensionApi()) return DEFAULT_SETTINGS;
  try {
    const stored = await extensionApi().storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }
};

/** Persist settings; resolves even when storage is unavailable. */
export const saveSettings = async (settings: PanelSettings): Promise<void> => {
  if (!hasExtensionApi()) return;
  try {
    await extensionApi().storage.local.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
  } catch {
    // Nothing actionable: the panel keeps working with in-memory settings.
  }
};
