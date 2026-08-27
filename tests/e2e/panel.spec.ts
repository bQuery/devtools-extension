import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_CAPABILITIES,
  FIXTURE_SNAPSHOT,
  FIXTURE_TIMELINE,
  FIXTURE_TREE,
  installFixture,
} from './fixture';

const openPanel = async (page: Page): Promise<void> => {
  await page.addInitScript(installFixture, {
    snapshot: FIXTURE_SNAPSHOT,
    tree: FIXTURE_TREE,
    timeline: FIXTURE_TIMELINE,
    capabilities: FIXTURE_CAPABILITIES,
  });
  await page.goto('/panel.html');
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
