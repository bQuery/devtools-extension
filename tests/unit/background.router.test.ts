import { beforeEach, describe, expect, test } from 'bun:test';
import { BridgeRouter, type RouterPort, type RouterSender } from '../../src/background/router';
import { ENVELOPE_SOURCE, PANEL_PORT_NAME } from '../../src/protocol/envelope';

class FakePort implements RouterPort {
  public readonly received: unknown[] = [];
  private messageListener: ((message: unknown) => void) | null = null;
  private disconnectListener: (() => void) | null = null;

  constructor(public readonly name: string = PANEL_PORT_NAME) {}

  public postMessage(message: unknown): void {
    this.received.push(message);
  }

  public readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListener = listener;
    },
  };

  public readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListener = listener;
    },
  };

  public emit(message: unknown): void {
    this.messageListener?.(message);
  }

  public disconnect(): void {
    this.disconnectListener?.();
  }

  /** The token handed out by the router, if this port attached. */
  public get token(): string {
    const attached = this.received.find(
      (message): message is { type: string; token: string } =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'attached'
    );
    return attached?.token ?? '';
  }
}

const attach = (port: FakePort, tabId: number): void => {
  port.emit({ source: ENVELOPE_SOURCE, type: 'attach', tabId });
};

let router: BridgeRouter;
let delivered: Array<{ tabId: number; payload: unknown }>;
let injected: number[];
let injectionError: Error | null;
let tokenCounter: number;

beforeEach(() => {
  delivered = [];
  injected = [];
  injectionError = null;
  tokenCounter = 0;
  router = new BridgeRouter({
    extensionId: 'test-extension',
    createToken: () => `token-${++tokenCounter}`,
    sendToTab: async (tabId, payload) => {
      delivered.push({ tabId, payload });
    },
    injectContentScript: async tabId => {
      if (injectionError) throw injectionError;
      injected.push(tabId);
    },
  });
});

describe('connections', () => {
  test('ignores ports that are not the panel port', () => {
    const port = new FakePort('some-other-extension');
    router.handleConnect(port);
    attach(port, 1);
    expect(port.received).toHaveLength(0);
    expect(router.attachedTabs).toBe(0);
  });

  test('attaching issues a session token once', () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 7);
    attach(port, 8);
    expect(port.received).toEqual([
      { source: ENVELOPE_SOURCE, type: 'attached', token: 'token-1', tabId: 7 },
    ]);
    expect(router.attachedTabs).toBe(1);
  });

  test('disconnecting frees the route', () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 3);
    port.disconnect();
    expect(router.attachedTabs).toBe(0);
  });

  test('a reconnecting panel replaces the old route for its tab', () => {
    const first = new FakePort();
    const second = new FakePort();
    router.handleConnect(first);
    router.handleConnect(second);
    attach(first, 5);
    attach(second, 5);
    expect(router.attachedTabs).toBe(1);

    // The stale port disconnecting must not tear down the live route.
    first.disconnect();
    expect(router.attachedTabs).toBe(1);
  });
});

describe('panel → page', () => {
  test('forwards a payload to the attached tab', async () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 42);
    port.emit({
      source: ENVELOPE_SOURCE,
      type: 'to-page',
      token: port.token,
      payload: { kind: 'hello' },
    });
    await Promise.resolve();
    expect(delivered).toEqual([{ tabId: 42, payload: { kind: 'hello' } }]);
  });

  test('drops a payload carrying the wrong token', async () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 42);
    port.emit({
      source: ENVELOPE_SOURCE,
      type: 'to-page',
      token: 'stolen',
      payload: { kind: 'hello' },
    });
    await Promise.resolve();
    expect(delivered).toEqual([]);
  });

  test('drops a payload sent before attaching', async () => {
    const port = new FakePort();
    router.handleConnect(port);
    port.emit({ source: ENVELOPE_SOURCE, type: 'to-page', token: '', payload: {} });
    await Promise.resolve();
    expect(delivered).toEqual([]);
  });

  test("one panel cannot reach another panel's tab", async () => {
    const a = new FakePort();
    const b = new FakePort();
    router.handleConnect(a);
    router.handleConnect(b);
    attach(a, 1);
    attach(b, 2);
    a.emit({ source: ENVELOPE_SOURCE, type: 'to-page', token: a.token, payload: 'from-a' });
    b.emit({ source: ENVELOPE_SOURCE, type: 'to-page', token: b.token, payload: 'from-b' });
    await Promise.resolve();
    expect(delivered).toEqual([
      { tabId: 1, payload: 'from-a' },
      { tabId: 2, payload: 'from-b' },
    ]);
  });
});

describe('page → panel', () => {
  const sender = (tabId?: number, id = 'test-extension'): RouterSender => ({
    id,
    ...(tabId === undefined ? {} : { tab: { id: tabId } }),
  });

  test('routes to the panel attached to the sending tab', () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 9);
    const routed = router.handleContentMessage(
      { source: ENVELOPE_SOURCE, type: 'from-page', payload: { kind: 'init' } },
      sender(9)
    );
    expect(routed).toBe(true);
    expect(port.received.at(-1)).toEqual({
      source: ENVELOPE_SOURCE,
      type: 'from-page',
      payload: { kind: 'init' },
    });
  });

  test.each([
    ['an unattached tab', 9, 4, 'test-extension'],
    ['a foreign extension', 9, 9, 'other-extension'],
  ])('drops a message from %s', (_label, attachedTab, senderTab, senderId) => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, attachedTab as number);
    const routed = router.handleContentMessage(
      { source: ENVELOPE_SOURCE, type: 'from-page', payload: {} },
      sender(senderTab as number, senderId as string)
    );
    expect(routed).toBe(false);
  });

  test('drops a message with no tab (i.e. not from a content script)', () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 1);
    expect(
      router.handleContentMessage(
        { source: ENVELOPE_SOURCE, type: 'from-page', payload: {} },
        sender(undefined)
      )
    ).toBe(false);
  });

  test('drops an envelope of the wrong type', () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 1);
    expect(
      router.handleContentMessage({ source: ENVELOPE_SOURCE, type: 'attach' }, sender(1))
    ).toBe(false);
  });
});

describe('injection', () => {
  test('reports success back to the panel', async () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 11);
    port.emit({ source: ENVELOPE_SOURCE, type: 'inject', token: port.token });
    await Promise.resolve();
    await Promise.resolve();
    expect(injected).toEqual([11]);
    expect(port.received.at(-1)).toEqual({
      source: ENVELOPE_SOURCE,
      type: 'inject-result',
      ok: true,
    });
  });

  test('reports the failure reason', async () => {
    injectionError = new Error('Cannot access contents of the page');
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 11);
    port.emit({ source: ENVELOPE_SOURCE, type: 'inject', token: port.token });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.received.at(-1)).toEqual({
      source: ENVELOPE_SOURCE,
      type: 'inject-result',
      ok: false,
      reason: 'Cannot access contents of the page',
    });
  });

  test('refuses an injection request without the session token', async () => {
    const port = new FakePort();
    router.handleConnect(port);
    attach(port, 11);
    port.emit({ source: ENVELOPE_SOURCE, type: 'inject', token: 'guessed' });
    await Promise.resolve();
    expect(injected).toEqual([]);
  });
});
