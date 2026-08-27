import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  normalizeSettings,
} from '../../src/panel/settings';
import { MAX_BUFFER_SIZE, MIN_BUFFER_SIZE } from '../../src/panel/timeline';

describe('normalizeSettings', () => {
  test('junk falls back to the defaults', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('corrupt')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  test('out-of-range values are clamped, not rejected', () => {
    expect(normalizeSettings({ bufferSize: 1, pollIntervalMs: 1 })).toMatchObject({
      bufferSize: MIN_BUFFER_SIZE,
      pollIntervalMs: MIN_POLL_INTERVAL_MS,
    });
    expect(normalizeSettings({ bufferSize: 1e9, pollIntervalMs: 1e9 })).toMatchObject({
      bufferSize: MAX_BUFFER_SIZE,
      pollIntervalMs: MAX_POLL_INTERVAL_MS,
    });
  });

  test('valid values round-trip', () => {
    const settings = { bufferSize: 750, pollIntervalMs: 500, preferLiveStreaming: true };
    expect(normalizeSettings(settings)).toEqual(settings);
  });

  test('preferLiveStreaming is strictly boolean', () => {
    expect(normalizeSettings({ preferLiveStreaming: 'yes' }).preferLiveStreaming).toBe(false);
    expect(normalizeSettings({ preferLiveStreaming: 1 }).preferLiveStreaming).toBe(false);
  });
});
