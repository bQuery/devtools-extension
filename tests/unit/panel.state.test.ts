import { beforeEach, describe, expect, test } from 'bun:test';
import { BridgeClient } from '../../src/protocol/client';
import { PanelState } from '../../src/panel/state';
import { TimelineBuffer } from '../../src/panel/timeline';
import { FakeClock, FakeTransport } from '../helpers/bridge';

const snapshot = {
  version: 1,
  exportedAt: 500,
  state: { timeline: [] },
  signals: [{ label: 'count', value: 0, subscriberCount: 1 }],
  stores: [{ id: 'cart', state: { items: 0 } }],
  components: [{ tagName: 'my-app', instanceCount: 1 }],
};

const componentTree = {
  tree: [{ tag: 'my-app', id: '0', attrs: {}, children: [] }],
  flat: [{ tagName: 'my-app', instanceCount: 1 }],
};

let transport: FakeTransport;
let client: BridgeClient;
let state: PanelState;
let buffer: TimelineBuffer;

/** Let queued microtasks and timers run. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Answer every request the state has issued so far, then keep going while it
 * issues follow-up requests (the snapshot fetch gates the timeline seed).
 */
const answerAll = async (results: Record<string, unknown>): Promise<void> => {
  for (let pass = 0; pass < 6; pass += 1) {
    await flush();
    let answeredAny = false;
    for (const message of transport.sent) {
      if (message.kind !== 'request' || transport.answered.has(message.id)) continue;
      transport.answered.add(message.id);
      transport.respond(message.id, { result: results[message.method] });
      answeredAny = true;
    }
    if (!answeredAny && pass > 1) break;
  }
  await flush();
};

beforeEach(() => {
  transport = new FakeTransport();
  client = new BridgeClient(transport, {
    requestTimeoutMs: 1000,
    helloIntervalMs: 1000,
    setTimeout: new FakeClock().setTimeout,
    clearTimeout: () => undefined,
  });
  buffer = new TimelineBuffer(100);
  state = new PanelState(client, buffer);
});

describe('connect', () => {
  test('fetches tree, snapshot and timeline seed once the page answers', async () => {
    state.start();
    transport.open();
    transport.init(['components', 'signals', 'stores', 'timeline', 'time-travel']);
    await answerAll({
      getComponentTree: componentTree,
      getSnapshot: snapshot,
      getTimeline: [{ type: 'mark', detail: 'boot', timestamp: 1 }],
    });

    expect(state.tree.value).toHaveLength(1);
    expect(state.signals.value[0]?.label).toBe('count');
    expect(state.stores.value[0]?.id).toBe('cart');
    expect(state.components.value[0]?.tagName).toBe('my-app');
    expect(state.entries()).toHaveLength(1);
    expect(state.lastError.value).toBe('');
    expect(state.loading.value).toBe(false);
  });

  test('skips requests for capabilities the page did not advertise', async () => {
    state.start();
    transport.open();
    transport.init(['signals']);
    await answerAll({ getSnapshot: snapshot });

    const methods = transport.sent
      .filter(message => message.kind === 'request')
      .map(message => message.method);
    expect(methods).toEqual(['getSnapshot']);
    expect(state.tree.value).toEqual([]);
  });

  test('events streamed during the seed fetch are not overwritten by it', async () => {
    state.start();
    transport.open();
    transport.init(['timeline']);
    await flush();

    // The page emits while `getTimeline` is still in flight.
    transport.event({ type: 'signal:update', detail: 'late', timestamp: 30 });
    await answerAll({
      getSnapshot: snapshot,
      getTimeline: [{ type: 'mark', detail: 'seeded', timestamp: 10 }],
    });

    expect(state.entries().map(entry => entry.detail)).toEqual(['seeded', 'late']);
  });

  test('an entry present in both the seed and the stream is kept once', async () => {
    state.start();
    transport.open();
    transport.init(['timeline']);
    await flush();

    const duplicate = { type: 'mark', detail: 'boot', timestamp: 10, source: 'app' };
    transport.event(duplicate);
    await answerAll({ getSnapshot: snapshot, getTimeline: [duplicate] });

    expect(state.entries()).toHaveLength(1);
  });

  test('a failed request surfaces as an error instead of throwing', async () => {
    state.start();
    transport.open();
    transport.init(['signals']);
    await flush();
    const request = transport.sent.find(message => message.kind === 'request');
    transport.respond(request?.id ?? 1, { error: 'devtools are disabled' });
    await flush();
    expect(state.lastError.value).toMatch(/devtools are disabled/);
    expect(state.loading.value).toBe(false);
  });
});

describe('streaming', () => {
  const connect = async (): Promise<void> => {
    state.start();
    transport.open();
    transport.init(['components', 'signals', 'stores', 'timeline', 'time-travel']);
    await answerAll({ getComponentTree: componentTree, getSnapshot: snapshot, getTimeline: [] });
  };

  test('buffers streamed events and bumps the revision', async () => {
    await connect();
    const before = state.timelineRevision.value;
    transport.event({ type: 'signal:update', detail: 'count', timestamp: 2 });
    expect(state.entries()).toHaveLength(1);
    expect(state.timelineRevision.value).toBeGreaterThan(before);
  });

  test('pausing drops streamed events', async () => {
    await connect();
    state.paused.value = true;
    transport.event({ type: 'signal:update', detail: 'count', timestamp: 2 });
    expect(state.entries()).toHaveLength(0);
  });

  test('clearing empties the buffer and leaves time travel', async () => {
    await connect();
    transport.event({ type: 'signal:update', detail: 'count', timestamp: 2 });
    state.travelTo(0);
    state.clearTimeline();
    expect(state.entries()).toHaveLength(0);
    expect(state.timeTravelIndex.value).toBeNull();
  });

  test('resizing the buffer keeps an in-range replay position', async () => {
    await connect();
    for (let index = 0; index < 10; index += 1) {
      transport.event({ type: 'signal:update', detail: `#${index}`, timestamp: index });
    }
    state.travelTo(9);
    state.setBufferSize(50);
    expect(state.bufferCapacity()).toBe(50);
    // The buffer still holds every entry, so the position is untouched.
    expect(state.timeTravelIndex.value).toBe(9);
  });

  test('shrinking the buffer past the replay position clamps it', async () => {
    await connect();
    // More than MIN_BUFFER_SIZE entries, or the capacity cannot drop below
    // the number buffered and the clamping branch stays unreachable.
    for (let index = 0; index < 60; index += 1) {
      transport.event({ type: 'signal:update', detail: `#${index}`, timestamp: index });
    }
    state.travelTo(59);
    state.setBufferSize(50);
    expect(state.entries()).toHaveLength(50);
    expect(state.timeTravelIndex.value).toBe(49);
  });
});

describe('time travel', () => {
  const connect = async (): Promise<void> => {
    state.start();
    transport.open();
    transport.init(['components', 'signals', 'stores', 'timeline', 'time-travel']);
    await answerAll({ getComponentTree: componentTree, getSnapshot: snapshot, getTimeline: [] });
  };

  test('is null while following live state', async () => {
    await connect();
    expect(state.reconstruction.value).toBeNull();
  });

  test('replays from the connect-time snapshot', async () => {
    await connect();
    transport.event({
      type: 'signal:update',
      detail: 'count',
      // After `snapshot.exportedAt`, so the replay base does not supersede it.
      timestamp: snapshot.exportedAt + 1,
      source: 'count',
      payload: { value: 42 },
    });
    state.travelTo(0);

    const replay = state.reconstruction.value;
    expect(replay?.index).toBe(0);
    expect(replay?.signals.find(item => item.label === 'count')?.value).toBe(42);
    // Travelling pauses streaming so the replayed view holds still.
    expect(state.paused.value).toBe(true);
  });

  test('resuming clears the replay and unpauses', async () => {
    await connect();
    transport.event({ type: 'signal:update', detail: 'count', timestamp: 2 });
    state.travelTo(0);
    state.resumeLive();
    expect(state.timeTravelIndex.value).toBeNull();
    expect(state.paused.value).toBe(false);
    expect(state.reconstruction.value).toBeNull();
  });

  test('travelling with an empty buffer is a no-op', async () => {
    await connect();
    state.travelTo(0);
    expect(state.timeTravelIndex.value).toBeNull();
  });
});

describe('reconnect', () => {
  test('refetches everything on a second handshake', async () => {
    state.start();
    transport.open();
    transport.init(['signals']);
    await answerAll({ getSnapshot: snapshot });
    const first = transport.sent.filter(message => message.kind === 'request').length;

    client.resetHandshake('page navigated');
    transport.init(['signals']);
    await answerAll({ getSnapshot: snapshot });
    expect(transport.sent.filter(message => message.kind === 'request').length).toBeGreaterThan(
      first
    );
  });
});
