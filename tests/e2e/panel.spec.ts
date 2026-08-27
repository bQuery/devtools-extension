import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_CAPABILITIES,
  FIXTURE_SNAPSHOT,
  FIXTURE_TIMELINE,
  FIXTURE_TREE,
  installFixture,
} from './fixture';

/**
 * Serve the panel against a page whose bridge is described by `overrides`.
 *
 * The default is a complete bQuery bridge. Passing `methods` or `capabilities`
 * models the partial ones — an app that loaded only part of the framework, or
 * a hand-rolled bridge that implements a subset.
 */
const openPanelAgainst = async (
  page: Page,
  overrides: {
    methods?: readonly string[];
    capabilities?: readonly string[];
    version?: number;
  } = {}
): Promise<void> => {
  await page.addInitScript(installFixture, {
    snapshot: FIXTURE_SNAPSHOT,
    tree: FIXTURE_TREE,
    timeline: FIXTURE_TIMELINE,
    capabilities: overrides.capabilities ?? FIXTURE_CAPABILITIES,
    ...(overrides.methods ? { methods: overrides.methods } : {}),
    ...(overrides.version !== undefined ? { version: overrides.version } : {}),
  });
  await page.goto('/panel.html');
};

const openPanel = async (page: Page): Promise<void> => {
  await openPanelAgainst(page);
  await expect(page.locator('.status')).toHaveText('Connected');
};

const openTab = async (page: Page, label: string): Promise<void> => {
  await page.getByRole('tab', { name: label }).click();
};

/** Stream one timeline entry from the fake page. */
const emit = async (page: Page, entry: Record<string, unknown>): Promise<void> => {
  await page.evaluate(
    payload => (window as unknown as { __emit: (entry: unknown) => void }).__emit(payload),
    entry
  );
};

test.describe('bQuery DevTools panel', () => {
  test('connects over the bridge and negotiates capabilities', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('.badge', { hasText: 'protocol v1' })).toBeVisible();
    for (const capability of FIXTURE_CAPABILITIES) {
      await expect(page.locator(`.badge.is-on`, { hasText: capability })).toBeVisible();
    }
    // Without a granted host permission the panel stays on the polling transport.
    await expect(page.locator('.badge', { hasText: 'polling' })).toBeVisible();
  });

  test('renders and filters the component tree', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('.tree-row')).toHaveCount(5);
    await expect(page.locator('.tree-tag').first()).toHaveText('<my-app>');
    await expect(page.locator('.tree-attrs').first()).toContainText('theme="dark"');

    await page.getByLabel('Filter components').fill('item');
    // my-app and my-list are kept as ancestors of the two matching items.
    await expect(page.locator('.tree-row')).toHaveCount(4);
    await expect(page.locator('.tree-row.is-match')).toHaveCount(2);

    await page.getByLabel('Filter components').fill('nothing-matches');
    await expect(page.locator('.empty')).toBeVisible();
  });

  test('shows signals and drills into a nested value', async ({ page }) => {
    await openPanel(page);
    await openTab(page, 'Signals');

    await expect(page.locator('.inspector-row')).toHaveCount(2);
    const countRow = page.locator('.inspector-row', { hasText: 'count' }).first();
    await expect(countRow.locator('.value-preview')).toHaveText('1');
    await expect(countRow.locator('.badge')).toHaveText('2 subscribers');

    const userRow = page.locator('.inspector-row', { hasText: 'user' }).first();
    await userRow.locator('.value-toggle').first().click();
    await expect(userRow.locator('.value-preview.value-string', { hasText: 'Ada' })).toBeVisible();
    await expect(userRow.locator('.value-key', { hasText: 'roles' })).toBeVisible();
  });

  test('shows stores', async ({ page }) => {
    await openPanel(page);
    await openTab(page, 'Stores');
    const row = page.locator('.inspector-row', { hasText: 'cart' }).first();
    await expect(row.locator('.badge')).toHaveText('2 keys');
    await row.locator('.value-toggle').first().click();
    await expect(row.locator('.value-key', { hasText: 'items' })).toBeVisible();
  });

  test('seeds the timeline, streams new events and filters them', async ({ page }) => {
    await openPanel(page);
    await openTab(page, 'Timeline');
    await expect(page.locator('.timeline-row')).toHaveCount(FIXTURE_TIMELINE.length);

    await emit(page, {
      timestamp: 1_700_000_000_003,
      type: 'store:patch',
      detail: 'cart items',
      source: 'cart',
      payload: { patch: { items: 3 } },
    });
    await expect(page.locator('.timeline-row')).toHaveCount(3);
    // Newest first.
    await expect(page.locator('.timeline-detail').first()).toHaveText('cart items');

    await page.getByLabel('Filter timeline events').fill('count');
    await expect(page.locator('.timeline-row')).toHaveCount(1);
    await page.getByLabel('Filter timeline events').fill('');

    await page.locator('.chip', { hasText: 'store:patch' }).click();
    await expect(page.locator('.timeline-row')).toHaveCount(1);
    await page.locator('.chip', { hasText: 'store:patch' }).click();
    await expect(page.locator('.timeline-row')).toHaveCount(3);
  });

  test('pauses and clears the buffer', async ({ page }) => {
    await openPanel(page);
    await openTab(page, 'Timeline');
    await page.getByRole('button', { name: 'Pause' }).click();
    await emit(page, { timestamp: 4, type: 'mark', detail: 'ignored' });
    await expect(page.locator('.timeline-row')).toHaveCount(FIXTURE_TIMELINE.length);

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.locator('.timeline-row')).toHaveCount(0);
    await expect(page.locator('.empty')).toBeVisible();
  });

  test('replays state at an earlier event', async ({ page }) => {
    await openPanel(page);
    await openTab(page, 'Timeline');
    await emit(page, {
      timestamp: 1_700_000_000_004,
      type: 'signal:update',
      detail: 'count → 99',
      source: 'count',
      payload: { value: 99 },
    });
    await expect(page.locator('.timeline-row')).toHaveCount(3);

    // Replay the state as of the *first* recorded event.
    await page.locator('.timeline-head').last().click();
    await page.getByRole('button', { name: 'Replay state at this event' }).click();
    await expect(page.locator('.scrubber .muted')).toContainText('applied');

    await openTab(page, 'Signals');
    const countRow = page.locator('.inspector-row', { hasText: 'count' }).first();
    await expect(countRow.locator('.value-preview')).toHaveText('1');
    await expect(countRow.locator('.badge')).toHaveText('unchanged');

    // Back to the newest event: the replayed value follows the stream.
    await openTab(page, 'Timeline');
    await page.locator('.scrubber-range').fill('2');
    await openTab(page, 'Signals');
    await expect(countRow.locator('.value-preview')).toHaveText('99');
    await expect(countRow.locator('.badge')).toHaveText('replayed');

    await openTab(page, 'Timeline');
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await openTab(page, 'Signals');
    await expect(countRow.locator('.value-preview')).toHaveText('1');
  });

  test('never renders page-supplied markup as HTML', async ({ page }) => {
    await page.addInitScript(installFixture, {
      snapshot: {
        ...FIXTURE_SNAPSHOT,
        signals: [
          {
            label: '<b>label</b>',
            value: '<img src=x onerror=window.__xss=1>',
            subscriberCount: 0,
          },
        ],
      },
      tree: {
        tree: [
          {
            tag: 'img src=x onerror=window.__xss=1',
            id: '0',
            attrs: { onerror: 'window.__xss = 1' },
            children: [],
          },
        ],
        flat: [],
      },
      timeline: [{ timestamp: 1, type: 'mark', detail: '<script>window.__xss = 1</script>' }],
      capabilities: FIXTURE_CAPABILITIES,
    });
    await page.goto('/panel.html');
    await expect(page.locator('.status')).toHaveText('Connected');

    await expect(page.locator('.tree-tag').first()).toHaveText(
      '<img src=x onerror=window.__xss=1>'
    );
    await expect(page.locator('.tree-list img')).toHaveCount(0);

    await openTab(page, 'Signals');
    await expect(page.locator('.inspector-key').first()).toHaveText('<b>label</b>');
    await expect(page.locator('.inspector-list b')).toHaveCount(0);

    await openTab(page, 'Timeline');
    await expect(page.locator('.timeline-detail').first()).toHaveText(
      '<script>window.__xss = 1</script>'
    );

    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>)['__xss'])
    ).toBeUndefined();
  });

  test('a prototype-chain method name is answered with an error, not dispatched', async ({
    page,
  }) => {
    await openPanel(page);
    // The fixture's method table is keyed off the wire. With a plain object it
    // would resolve "constructor" through the prototype chain and invoke it;
    // the panel would then be handed `Object` as a result.
    const replies = await page.evaluate(async () => {
      const answers: unknown[] = [];
      let settle = (): void => undefined;
      const collect = (event: MessageEvent): void => {
        const data = event.data as Record<string, unknown> | null;
        if (!data || data['source'] !== 'bquery-devtools' || data['kind'] !== 'response') return;
        // Only this test's requests: the panel's own connect-time fetches are
        // still in flight on the same bus, and collecting those made the
        // assertion race.
        if (typeof data['id'] !== 'number' || data['id'] < 9000) return;
        answers.push(data['error'] ?? data['result']);
        settle();
      };
      const methods = ['constructor', 'toString', '__proto__'];
      // Settle on the expected count rather than a fixed delay: a slow task
      // queue would otherwise make this assert against a partial result.
      const collected = new Promise<void>(resolve => {
        settle = () => {
          if (answers.length >= methods.length) resolve();
        };
      });
      window.addEventListener('message', collect);
      for (const [index, method] of methods.entries()) {
        window.postMessage(
          {
            source: 'bquery-devtools',
            channel: 'panel',
            v: 1,
            kind: 'request',
            id: 9000 + index,
            method,
          },
          '*'
        );
      }
      await Promise.race([collected, new Promise(resolve => setTimeout(resolve, 2000))]);
      window.removeEventListener('message', collect);
      return answers;
    });

    expect(replies).toHaveLength(3);
    for (const reply of replies) {
      expect(String(reply)).toContain('Unknown method');
    }
  });

  test('interactive controls survive their own reactive re-render', async ({ page }) => {
    await openPanel(page);

    // Each of these writes the signal its own view reads, so a full-subtree
    // re-render would detach the focused control mid-interaction. Typing
    // character by character is what exposes it — `fill()` sets the value in
    // one operation and passes either way.
    const treeSearch = page.getByLabel('Filter components');
    await treeSearch.click();
    await page.keyboard.type('item', { delay: 20 });
    await expect(treeSearch).toHaveValue('item');
    await expect(page.locator('.tree-row')).toHaveCount(4);

    await openTab(page, 'Timeline');
    const eventSearch = page.getByLabel('Filter timeline events');
    await eventSearch.click();
    await page.keyboard.type('count', { delay: 20 });
    await expect(eventSearch).toHaveValue('count');
    await expect(page.locator('.timeline-row')).toHaveCount(1);
  });

  test('reports a page that never answers the handshake', async ({ page }) => {
    // No fixture bridge: only the chrome mock, so `hello` goes unanswered.
    await page.addInitScript(() => {
      const scope = window as unknown as Record<string, unknown>;
      scope['chrome'] = {
        runtime: { id: 'e2e', onMessage: { addListener: () => undefined } },
        storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
        permissions: { contains: () => Promise.resolve(false) },
        devtools: {
          inspectedWindow: {
            tabId: 1,
            eval: (expression: string, callback: (result: unknown) => void) => {
              const evaluate = eval;
              callback(evaluate(expression));
            },
          },
          network: { onNavigated: { addListener: () => undefined } },
        },
      };
    });
    await page.goto('/panel.html');
    await expect(page.locator('.status')).toHaveText('Waiting for the page');
    await expect(page.getByRole('tab', { name: 'Components' })).toBeVisible();
  });
});

/**
 * bQuery is modular, and its bridge is a contract anyone can implement. These
 * cover the pages that only implement part of it: nothing here may leave the
 * panel blank, stuck, or claiming something the page never said.
 */
test.describe('partially implemented bridges', () => {
  test('a bridge with only getTimeline still shows a timeline', async ({ page }) => {
    // Advertises nothing at all, so the panel has to find out by asking.
    await openPanelAgainst(page, { methods: ['getTimeline'], capabilities: [] });
    await expect(page.locator('.status')).toHaveText('Connected');

    await openTab(page, 'Timeline');
    await expect(page.locator('.timeline-row')).toHaveCount(FIXTURE_TIMELINE.length);

    // …and the sections it cannot serve say exactly that, rather than
    // pretending the app has no signals.
    await openTab(page, 'Signals');
    await expect(page.locator('.empty')).toContainText('does not provide signals');
    await expect(page.locator('.empty')).toContainText('does not implement this bridge method');
  });

  test('a snapshot-only bridge falls back to the flat component registry', async ({ page }) => {
    await openPanelAgainst(page, { methods: ['getSnapshot', 'getTimeline'] });
    await expect(page.locator('.status')).toHaveText('Connected');

    await openTab(page, 'Components');
    // No tree to nest, but the snapshot knows which components are mounted.
    await expect(page.locator('.muted', { hasText: 'No component tree' })).toBeVisible();
    await expect(page.locator('.tree-row.is-flat')).toHaveCount(FIXTURE_SNAPSHOT.components.length);
    await expect(page.locator('.tree-tag').first()).toHaveText('<my-app>');

    // The filter works on the fallback too, and the count agrees with it.
    await page.getByLabel('Filter components').fill('item');
    await expect(page.locator('.tree-row.is-flat')).toHaveCount(1);
    await expect(page.locator('.view-toolbar .muted')).toHaveText('1 matching');

    // The rest of the panel is unaffected by the missing method.
    await openTab(page, 'Signals');
    await expect(page.locator('.inspector-row')).toHaveCount(FIXTURE_SNAPSHOT.signals.length);
  });

  test('a section the page refused is re-probed only when the user asks', async ({ page }) => {
    await openPanelAgainst(page, { methods: ['getSnapshot'] });
    await expect(page.locator('.status')).toHaveText('Connected');
    await expect(page.locator('.badge.is-on', { hasText: 'signals' })).toBeVisible();

    const asked = (): Promise<number> =>
      page.evaluate(() => (window as unknown as { __asked: number }).__asked);
    await page.evaluate(() => {
      const scope = window as unknown as { __asked: number };
      scope.__asked = 0;
      window.addEventListener('message', event => {
        const data = event.data as Record<string, unknown> | null;
        if (data && data['kind'] === 'request' && data['method'] === 'getComponentTree') {
          scope.__asked += 1;
        }
      });
    });

    // Nothing is asked while the panel simply sits there: the page already
    // refused this method, and the verdict holds until someone overrides it.
    await page.waitForTimeout(600);
    expect(await asked()).toBe(0);

    // "Refresh all" is that override — and it re-probes exactly once, so a
    // user who just mounted their first component gets it back. Polled: the
    // click only schedules the request, and the signals badge was already lit
    // before it, so nothing else here waits for the round trip.
    await page.getByRole('button', { name: 'Refresh all' }).click();
    await expect.poll(asked).toBe(1);
    await page.waitForTimeout(400);
    expect(await asked()).toBe(1);
  });

  test('a page speaking a newer protocol is named, not waited on', async ({ page }) => {
    await openPanelAgainst(page, { version: 2 });
    await expect(page.locator('.status')).toHaveText('Incompatible protocol');
    await expect(page.locator('.status-message')).toContainText('protocol v2');
    await expect(page.locator('.status-message')).toContainText('Update the extension');
  });

  test('a page advertising capabilities this build has no view for says so', async ({ page }) => {
    await openPanelAgainst(page, {
      capabilities: [...FIXTURE_CAPABILITIES, 'router', 'hydration'],
    });
    await expect(page.locator('.status')).toHaveText('Connected');
    await expect(page.locator('.badge', { hasText: '+2 unknown' })).toBeVisible();
  });
});
