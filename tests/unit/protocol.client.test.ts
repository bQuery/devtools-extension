import { beforeEach, describe, expect, test } from 'bun:test';
import { BridgeClient, BridgeMethodError, BridgeTimeoutError } from '../../src/protocol/client';
import { FakeClock, FakeTransport } from '../helpers/bridge';

let transport: FakeTransport;
let clock: FakeClock;
let client: BridgeClient;

beforeEach(() => {
  transport = new FakeTransport();
  clock = new FakeClock();
  client = new BridgeClient(transport, {
    requestTimeoutMs: 1000,
    helloIntervalMs: 100,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
});

describe('handshake', () => {
  test('retries hello until the page answers', () => {
    client.start();
    transport.open();
    expect(client.state.value).toBe('waiting-for-page');
    expect(transport.sent).toHaveLength(1);

    clock.advance(100);
    clock.advance(100);
    expect(transport.sent).toHaveLength(3);

    transport.init(['signals', 'timeline']);
    expect(client.state.value).toBe('connected');

    clock.advance(1000);
    expect(transport.sent).toHaveLength(3);
  });

  test('negotiates capabilities and notifies onReady on every connect', () => {
    const seen: string[][] = [];
    client.onReady(capabilities => seen.push([...capabilities].sort()));
    client.start();
    transport.open();
    transport.init(['signals', 'stores', 'wormhole']);

    expect([...client.capabilities.value].sort()).toEqual(['signals', 'stores']);

    client.resetHandshake('page navigated');
    transport.init(['timeline']);
    expect(seen).toEqual([['signals', 'stores'], ['timeline']]);
  });
});

describe('requests', () => {
  test('correlates responses by id', async () => {
    client.start();
    transport.open();
    transport.init(['signals']);

    const first = client.request<number>('getSnapshot');
    const second = client.request<number>('getTimeline');
    // Answered out of order on purpose.
    transport.respond(2, { result: 22 });
    transport.respond(1, { result: 11 });

    expect(await first).toBe(11);
    expect(await second).toBe(22);
  });

  test('rejects with the page-supplied error', async () => {
    client.start();
    transport.open();
    const pending = client.request('nope');
    transport.respond(1, { error: 'Unknown method: nope' });
    await expect(pending).rejects.toBeInstanceOf(BridgeMethodError);
  });

  test('times out instead of leaking the promise', async () => {
    client.start();
    transport.open();
    const pending = client.request('getSnapshot');
    clock.advance(1000);
    await expect(pending).rejects.toBeInstanceOf(BridgeTimeoutError);
  });

  test('clears the timeout once answered', async () => {
    client.start();
    transport.open();
    const pending = client.request('ping');
    transport.respond(1, { result: 'pong' });
    await pending;
    // Only the hello retry timer may remain.
    clock.advance(5000);
    expect(client.state.value).not.toBe('error');
  });
});

describe('reconnection', () => {
  test('a closed transport rejects everything in flight', async () => {
    client.start();
    transport.open();
    transport.init(['signals']);
    const pending = client.request('getSnapshot');
    transport.close('background worker disconnected');
    await expect(pending).rejects.toThrow(/background worker disconnected/);
    expect(client.state.value).toBe('disconnected');
    expect(client.capabilities.value.size).toBe(0);
  });

  test('resetHandshake restarts hello and clears capabilities', () => {
    client.start();
    transport.open();
    transport.init(['signals']);
    const before = transport.sent.length;

    client.resetHandshake();
    expect(client.state.value).toBe('waiting-for-page');
    expect(client.capabilities.value.size).toBe(0);
    expect(transport.sent.length).toBe(before + 1);
  });

  test('a streamed event proves the page is alive', () => {
    const entries: string[] = [];
    client.onEvent(entry => entries.push(entry.type));
    client.start();
    transport.open();
    transport.event({ type: 'signal:update', detail: 'count', timestamp: 1 });
    expect(entries).toEqual(['signal:update']);
    expect(client.state.value).toBe('connected');
  });
});

describe('dispose', () => {
  test('tears down timers, listeners and the transport', async () => {
    client.start();
    transport.open();
    const pending = client.request('ping');
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    expect(transport.disposed).toBe(true);
    expect(clock.pending).toBe(0);
    await expect(client.request('ping')).rejects.toThrow(/disposed/);
  });
});
