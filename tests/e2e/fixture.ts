/**
 * The page-side half of the E2E smoke test.
 *
 * `installFixture` is serialized into the browser and runs *before* the panel
 * bundle, where it installs two things:
 *
 *  1. a `chrome` mock providing exactly the APIs the panel touches — most
 *     importantly `devtools.inspectedWindow.eval`, which here evaluates in the
 *     same page, so the real `EvalTransport` expressions really do run;
 *  2. a bridge server that speaks protocol v1 over `window.postMessage`,
 *     mirroring `createBridgeServer()` from `@bquery/bquery/devtools`.
 *
 * The result is the whole panel stack under test against a faithful page.
 */

/** Snapshot the fake page reports, mirroring `exportDevtoolsSnapshot()`. */
export const FIXTURE_SNAPSHOT = {
  version: 1,
  exportedAt: 1_700_000_000_000,
  state: { enabled: true, options: {}, timeline: [] },
  signals: [
    { label: 'count', value: 1, subscriberCount: 2 },
    { label: 'user', value: { name: 'Ada', roles: ['admin', 'dev'] }, subscriberCount: 1 },
  ],
  stores: [{ id: 'cart', state: { items: 0, open: false } }],
  components: [
    { tagName: 'my-app', instanceCount: 1 },
    { tagName: 'my-item', instanceCount: 2 },
  ],
};

/** Component tree the fake page reports. */
export const FIXTURE_TREE = {
  tree: [
    {
      tag: 'my-app',
      id: '0',
      attrs: { theme: 'dark' },
      children: [
        { tag: 'my-header', id: '0/0', attrs: { title: 'Dashboard' }, children: [] },
        {
          tag: 'my-list',
          id: '0/1',
          attrs: {},
          children: [
            { tag: 'my-item', id: '0/1/0', attrs: { label: 'first' }, children: [] },
            { tag: 'my-item', id: '0/1/1', attrs: { label: 'second' }, children: [] },
          ],
        },
      ],
    },
  ],
  flat: FIXTURE_SNAPSHOT.components,
};

/** Timeline the fake page has already recorded when the panel connects. */
export const FIXTURE_TIMELINE = [
  { timestamp: 1_700_000_000_001, type: 'component:mount', detail: 'my-app', source: 'my-app' },
  {
    timestamp: 1_700_000_000_002,
    type: 'signal:update',
    detail: 'count → 1',
    source: 'count',
    payload: { value: 1 },
  },
];

/** Capabilities the fake page advertises. */
export const FIXTURE_CAPABILITIES = ['signals', 'stores', 'components', 'timeline', 'time-travel'];

interface FixtureData {
  snapshot: unknown;
  tree: unknown;
  timeline: unknown;
  capabilities: readonly string[];
  /**
   * Bridge methods this page implements. Anything outside the list answers
   * `Unknown method`, exactly as `createBridgeServer` does — which is how a
   * partially implemented bridge behaves. Defaults to all of them.
   */
  methods?: readonly string[];
  /** Protocol version the page speaks. Defaults to the v1 the panel expects. */
  version?: number;
}

/**
 * Runs in the browser before the panel bundle. Kept dependency-free and
 * self-contained: Playwright serializes it as source.
 */
export const installFixture = (data: FixtureData): void => {
  const SOURCE = 'bquery-devtools';
  const scope = window as unknown as Record<string, unknown>;
  const storage: Record<string, unknown> = {};
  const inspected: unknown[] = [];

  scope['__inspected'] = inspected;
  scope['inspect'] = (element: unknown): void => {
    inspected.push(element);
  };

  scope['chrome'] = {
    runtime: {
      id: 'e2e-extension',
      connect: () => ({
        postMessage: () => undefined,
        disconnect: () => undefined,
        onMessage: { addListener: () => undefined },
        onDisconnect: { addListener: () => undefined },
      }),
      onMessage: { addListener: () => undefined },
      onConnect: { addListener: () => undefined },
      sendMessage: () => Promise.resolve(),
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: storage[key] }),
        set: (values: Record<string, unknown>) => {
          Object.assign(storage, values);
          return Promise.resolve();
        },
      },
    },
    permissions: {
      contains: () => Promise.resolve(false),
      request: () => Promise.resolve(false),
    },
    devtools: {
      inspectedWindow: {
        tabId: 1,
        eval: (expression: string, callback: (result: unknown, info?: unknown) => void): void => {
          try {
            // Indirect eval: the fixture page *is* the inspected page here.
            const evaluate = eval;
            callback(evaluate(expression), undefined);
          } catch (error) {
            callback(undefined, { isException: true, value: String(error) });
          }
        },
      },
      network: { onNavigated: { addListener: () => undefined } },
      panels: { create: () => undefined },
    },
  };

  // --- page-side bridge server (protocol v1) --------------------------------

  const post = (message: Record<string, unknown>): void => {
    window.postMessage({ source: SOURCE, channel: 'page', v: data.version ?? 1, ...message }, '*');
  };

  /** `undefined` means "every built-in", matching a complete bridge server. */
  const implemented = (name: string): boolean => !data.methods || data.methods.indexOf(name) >= 0;

  /**
   * Answer one bridge method.
   *
   * A `switch` rather than a lookup table: the method name arrives off the
   * wire, and neither an object literal (which resolves "constructor" and
   * friends through the prototype chain) nor a keyed table selecting a
   * function value should decide what gets invoked. Here user input picks a
   * branch, never a callable. The real page-side bridge treats the panel as
   * untrusted too, so the fixture should not be sloppier than what it stands
   * in for.
   */
  const answer = (name: string): { known: true; result: unknown } | { known: false } => {
    if (!implemented(name)) return { known: false };
    switch (name) {
      case 'ping':
        return { known: true, result: { v: 1, ok: true } };
      case 'getSnapshot':
        return { known: true, result: data.snapshot };
      case 'getComponentTree':
        return { known: true, result: data.tree };
      case 'getTimeline':
        return { known: true, result: data.timeline };
      default:
        return { known: false };
    }
  };

  window.addEventListener('message', event => {
    const message = event.data as Record<string, unknown> | null;
    if (!message || message['source'] !== SOURCE || message['channel'] !== 'panel') return;
    if (message['kind'] === 'hello') {
      post({ kind: 'init', capabilities: data.capabilities });
      return;
    }
    if (message['kind'] !== 'request') return;
    const reply = answer(String(message['method']));
    if (!reply.known) {
      post({ kind: 'response', id: message['id'], error: `Unknown method: ${message['method']}` });
      return;
    }
    post({ kind: 'response', id: message['id'], result: reply.result });
  });

  /** Lets the test stream a timeline event from the fake page. */
  scope['__emit'] = (entry: unknown): void => {
    post({ kind: 'event', entry });
  };
};
