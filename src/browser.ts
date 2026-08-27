/**
 * Cross-browser API access.
 *
 * Firefox exposes the WebExtension API as `browser`, Chromium as `chrome`;
 * both ship the `chrome.*` alias for the callback-style APIs this extension
 * uses, so a single typed accessor is enough — no polyfill dependency.
 *
 * @module browser
 */

/** The subset of `chrome.*` this extension touches. */
type ExtensionApi = typeof chrome;

interface GlobalWithBrowser {
  browser?: ExtensionApi;
  chrome?: ExtensionApi;
}

/**
 * The WebExtension API for the current browser.
 *
 * @throws When called outside an extension context (e.g. a plain web page).
 */
export const extensionApi = (): ExtensionApi => {
  const scope = globalThis as unknown as GlobalWithBrowser;
  const api = scope.browser ?? scope.chrome;
  if (!api) throw new Error('bQuery DevTools: no WebExtension API available');
  return api;
};

/** `true` when a WebExtension API is reachable at all. */
export const hasExtensionApi = (): boolean => {
  const scope = globalThis as unknown as GlobalWithBrowser;
  return Boolean(scope.browser ?? scope.chrome);
};
