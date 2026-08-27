import { describe, expect, test } from 'bun:test';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE,
  foreignProtocolVersion,
  helloMessage,
  negotiateCapabilities,
  parseOutbound,
  requestMessage,
  unknownCapabilities,
} from '../../src/protocol/messages';

const pageMessage = (extra: Record<string, unknown>): Record<string, unknown> => ({
  source: BRIDGE_SOURCE,
  channel: 'page',
  v: BRIDGE_PROTOCOL_VERSION,
  ...extra,
});

describe('message builders', () => {
  test('hello carries the negotiated version and panel channel', () => {
    expect(helloMessage()).toEqual({
      source: BRIDGE_SOURCE,
      channel: 'panel',
      v: 1,
      kind: 'hello',
    });
  });

  test('request omits params when none are given', () => {
    expect(requestMessage(7, 'ping')).not.toHaveProperty('params');
    expect(requestMessage(7, 'getTimeline', { limit: 5 })).toMatchObject({
      id: 7,
      method: 'getTimeline',
      params: { limit: 5 },
    });
  });
});

describe('parseOutbound', () => {
  test('accepts an init handshake', () => {
    const parsed = parseOutbound(pageMessage({ kind: 'init', capabilities: ['signals', 42] }));
    expect(parsed).toEqual({
      source: BRIDGE_SOURCE,
      channel: 'page',
      v: 1,
      kind: 'init',
      capabilities: ['signals'],
    });
  });

  test('accepts a result response and an error response', () => {
    expect(
      parseOutbound(pageMessage({ kind: 'response', id: 1, result: { ok: true } }))
    ).toMatchObject({ id: 1, result: { ok: true } });
    const failed = parseOutbound(pageMessage({ kind: 'response', id: 2, error: 'boom' }));
    expect(failed).toMatchObject({ id: 2, error: 'boom' });
    expect(failed).not.toHaveProperty('result');
  });

  test('normalizes a streamed timeline entry', () => {
    const parsed = parseOutbound(
      pageMessage({
        kind: 'event',
        entry: {
          type: 'signal:update',
          detail: 'count',
          timestamp: 5,
          source: 'count',
          duration: 1.5,
          payload: { value: 2 },
          // Unknown fields must not survive.
          rogue: '<img src=x onerror=alert(1)>',
        },
      })
    );
    expect(parsed?.kind).toBe('event');
    const entry = (parsed as unknown as { entry: Record<string, unknown> }).entry;
    expect(entry).toEqual({
      timestamp: 5,
      type: 'signal:update',
      detail: 'count',
      payload: { value: 2 },
      source: 'count',
      duration: 1.5,
    });
  });

  test.each([
    ['not an object', 42],
    ['foreign source', { source: 'evil', channel: 'page', v: 1, kind: 'init' }],
    ['panel channel echoed back', pageMessage({ channel: 'panel', kind: 'init' })],
    ['unknown kind', pageMessage({ kind: 'shutdown' })],
    ['response without a numeric id', pageMessage({ kind: 'response', id: 'one' })],
    ['event without an entry type', pageMessage({ kind: 'event', entry: { detail: 'x' } })],
  ])('rejects %s', (_label, input) => {
    expect(parseOutbound(input)).toBeNull();
  });

  test('rejects another protocol version instead of guessing', () => {
    expect(
      parseOutbound({ source: BRIDGE_SOURCE, channel: 'page', v: 2, kind: 'init' })
    ).toBeNull();
  });
});

describe('negotiateCapabilities', () => {
  test('keeps known capabilities and drops the rest', () => {
    const negotiated = negotiateCapabilities(['signals', 'stores', 'teleport']);
    expect([...negotiated].sort()).toEqual(['signals', 'stores']);
  });

  test('an empty handshake negotiates nothing', () => {
    expect(negotiateCapabilities([]).size).toBe(0);
  });
});

describe('foreignProtocolVersion', () => {
  test('names the version of a bridge message this panel cannot read', () => {
    expect(
      foreignProtocolVersion({ source: BRIDGE_SOURCE, channel: 'page', v: 2, kind: 'init' })
    ).toBe(2);
  });

  test('is silent about messages this panel can read, and about foreign traffic', () => {
    expect(
      foreignProtocolVersion({ source: BRIDGE_SOURCE, channel: 'page', v: 1, kind: 'init' })
    ).toBeNull();
    expect(foreignProtocolVersion({ source: 'other-extension', channel: 'page', v: 9 })).toBeNull();
    expect(foreignProtocolVersion({ source: BRIDGE_SOURCE, channel: 'panel', v: 9 })).toBeNull();
    expect(foreignProtocolVersion('nope')).toBeNull();
  });

  test('ignores a non-numeric version rather than reporting NaN at the user', () => {
    expect(
      foreignProtocolVersion({ source: BRIDGE_SOURCE, channel: 'page', v: 'two', kind: 'init' })
    ).toBeNull();
  });
});

describe('unknownCapabilities', () => {
  test('lists what the page offers that this build has no view for', () => {
    expect(unknownCapabilities(['signals', 'router', 'ssr'])).toEqual(['router', 'ssr']);
    expect(unknownCapabilities(['signals'])).toEqual([]);
  });
});
