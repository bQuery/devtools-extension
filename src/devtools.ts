/**
 * DevTools page — registers the "bQuery" panel.
 *
 * This is the only script the browser loads when DevTools opens; the panel
 * itself is created lazily by the browser when the tab is first selected.
 *
 * @module devtools
 */
import { extensionApi } from './browser';

extensionApi().devtools.panels.create('bQuery', 'icons/icon48.png', 'panel.html', () => {
  // The panel drives its own connection; nothing to do here.
});
