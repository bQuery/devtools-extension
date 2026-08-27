/**
 * Content script for the optional port transport.
 *
 * It is *not* declared in the manifest: the panel injects it on demand, after
 * the user grants the origin permission for the site they are debugging. Its
 * only job is to relay the bridge protocol between the page's `window`
 * (where `connectDevtoolsBridge()` listens) and the background router.
 *
 * The script is idempotent — re-injection after a navigation must not install
 * a second listener pair.
 *
 * @module content
 */
import { extensionApi } from './browser';
import { BRIDGE_SOURCE } from './protocol/messages';
import { ENVELOPE_SOURCE } from './protocol/envelope';

const INSTALLED_FLAG = '__bqueryDevtoolsRelayInstalled';

interface RelayScope {
  [INSTALLED_FLAG]?: boolean;
}

const scope = window as unknown as RelayScope;

if (!scope[INSTALLED_FLAG]) {
  scope[INSTALLED_FLAG] = true;
  const api = extensionApi();

  // Page → background. Only same-window page-channel bridge messages qualify;
  // everything else on the very busy `message` bus is ignored.
  window.addEventListener('message', event => {
    const data: unknown = event.data;
    if (event.source !== window || typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    if (record['source'] !== BRIDGE_SOURCE || record['channel'] !== 'page') return;
    try {
      void api.runtime
        .sendMessage({ source: ENVELOPE_SOURCE, type: 'from-page', payload: data })
        .catch(() => {
          // The worker may be asleep or the panel closed; the panel re-handshakes.
        });
    } catch {
      // Extension context invalidated (reloaded/updated) — drop the frame.
    }
  });

  // Background (panel) → page.
  api.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return undefined;
    const record = message as Record<string, unknown>;
    if (record['source'] !== ENVELOPE_SOURCE || record['type'] !== 'to-page') return undefined;
    // Same-window delivery; opaque origins (`file:`, sandboxed frames)
    // report "null", for which an explicit target origin is invalid.
    const origin = window.location.origin;
    window.postMessage(record['payload'], origin && origin !== 'null' ? origin : '*');
    return undefined;
  });
}
