/**
 * Background service worker (MV3) / background script (MV2).
 *
 * It exists only for the optional *port* transport: routing bridge traffic
 * between a DevTools panel and the content script of the tab it inspects,
 * and injecting that content script on demand once the user has granted the
 * origin permission. The default eval transport does not involve this worker
 * at all, which is why the extension ships without any static content script
 * or host permission.
 *
 * @module background
 */
import { extensionApi } from './browser';
import { ENVELOPE_SOURCE } from './protocol/envelope';
import { BridgeRouter, type RouterPort, type RouterSender } from './background/router';

const CONTENT_SCRIPT_FILE = 'content.js';

const api = extensionApi();

const router = new BridgeRouter({
  extensionId: api.runtime.id,
  createToken: () => crypto.randomUUID(),
  sendToTab: async (tabId, payload) => {
    await api.tabs.sendMessage(tabId, {
      source: ENVELOPE_SOURCE,
      type: 'to-page',
      payload,
    });
  },
  injectContentScript: async tabId => {
    const scripting = (api as { scripting?: typeof chrome.scripting }).scripting;
    if (scripting?.executeScript) {
      await scripting.executeScript({
        target: { tabId },
        files: [CONTENT_SCRIPT_FILE],
        injectImmediately: true,
      });
      return;
    }
    // MV2 (Firefox) fallback.
    const legacyTabs = api.tabs as unknown as {
      executeScript?: (
        tabId: number,
        details: { file: string; runAt?: string }
      ) => Promise<unknown>;
    };
    if (!legacyTabs.executeScript) {
      throw new Error('script injection is not supported in this browser');
    }
    await legacyTabs.executeScript(tabId, { file: CONTENT_SCRIPT_FILE, runAt: 'document_start' });
  },
});

api.runtime.onConnect.addListener(port => {
  router.handleConnect(port as unknown as RouterPort);
});

api.runtime.onMessage.addListener((message: unknown, sender) => {
  router.handleContentMessage(message, sender as RouterSender);
  // Nothing here answers synchronously; returning `undefined` keeps the
  // message channel from being held open.
  return undefined;
});
