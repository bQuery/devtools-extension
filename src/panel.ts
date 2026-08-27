/**
 * DevTools panel entry point.
 *
 * Wires a transport → {@link BridgeClient} → {@link PanelState} → Web
 * Components, and owns the two things only the entry point can do: reacting
 * to page navigation, and upgrading from the permission-free polling
 * transport to live streaming once the user grants the origin permission.
 *
 * @module panel
 */
import { extensionApi, hasExtensionApi } from './browser';
import { BridgeClient } from './protocol/client';
import type { BridgeTransport } from './protocol/transport';
import { EvalTransport } from './transports/evalTransport';
import { PortTransport } from './transports/portTransport';
import { providePanelState } from './panel/components/base';
import type { PanelShell } from './panel/components/shell';
import './panel/components/shell';
import { loadSettings, type PanelSettings } from './panel/settings';
import { PanelState } from './panel/state';
import { TimelineBuffer } from './panel/timeline';
import './sass/panel.sass';

/** Root element the shell is mounted into. */
const ROOT_ID = 'panel-root';

interface Mounted {
  readonly client: BridgeClient;
  readonly state: PanelState;
  readonly shell: PanelShell;
}

/** The buffer survives transport swaps, so no history is lost on upgrade. */
let buffer: TimelineBuffer;
let mounted: Mounted | null = null;
let settings: PanelSettings;

const inspectedTabId = (): number => {
  if (!hasExtensionApi()) return -1;
  return extensionApi().devtools?.inspectedWindow?.tabId ?? -1;
};

/** Read the inspected page's origin without needing a host permission. */
const inspectedOrigin = (): Promise<string | null> =>
  new Promise(resolve => {
    if (!hasExtensionApi()) {
      resolve(null);
      return;
    }
    const devtools = extensionApi().devtools;
    if (!devtools?.inspectedWindow?.eval) {
      resolve(null);
      return;
    }
    devtools.inspectedWindow.eval('location.origin', (result: unknown) => {
      resolve(typeof result === 'string' && result !== 'null' ? result : null);
    });
  });

const mount = (transport: BridgeTransport, streaming: boolean): Mounted => {
  const client = new BridgeClient(transport);
  const state = new PanelState(client, buffer);
  providePanelState(state);

  const root = document.getElementById(ROOT_ID);
  if (!root) throw new Error(`bQuery DevTools: #${ROOT_ID} is missing from panel.html`);
  root.textContent = '';

  const shell = document.createElement('bq-panel') as PanelShell;
  shell.streaming = streaming;
  shell.onUpgrade = streaming ? null : upgradeToLiveStreaming;
  root.appendChild(shell);

  state.start();
  return { client, state, shell };
};

const unmount = (): void => {
  if (!mounted) return;
  mounted.state.dispose();
  mounted.client.dispose();
  mounted = null;
};

/**
 * Swap the polling transport for the push transport.
 *
 * Runs on a click, because `permissions.request()` requires a user gesture.
 * Any failure leaves the polling transport in place — the panel keeps working
 * either way.
 */
async function upgradeToLiveStreaming(): Promise<void> {
  try {
    const origin = await inspectedOrigin();
    if (!origin) throw new Error('the inspected page has no addressable origin');
    const api = extensionApi();
    const pattern = `${origin}/*`;
    const granted =
      (await api.permissions.contains({ origins: [pattern] })) ||
      (await api.permissions.request({ origins: [pattern] }));
    if (!granted) throw new Error('permission for this site was declined');

    const transport = new PortTransport({ tabId: inspectedTabId() });
    unmount();
    mounted = mount(transport, true);
    await transport.requestInjection();
  } catch (error) {
    // Always land on a working transport: fall back to polling and say why.
    unmount();
    mounted = mount(createEvalTransport(), false);
    mounted.state.lastError.value = `Live streaming unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

const createEvalTransport = (): EvalTransport =>
  new EvalTransport({ pollIntervalMs: settings.pollIntervalMs });

/**
 * Surface uncaught panel errors in the status bar.
 *
 * A DevTools panel has no visible console of its own — an error that only
 * reaches `console.error` is an error nobody sees.
 */
const installErrorBoundary = (): void => {
  const report = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error('bQuery DevTools:', reason);
    if (mounted) mounted.state.lastError.value = message;
  };
  window.addEventListener('error', event => report(event.error ?? event.message));
  window.addEventListener('unhandledrejection', event => report(event.reason));
};

const start = async (): Promise<void> => {
  installErrorBoundary();
  settings = await loadSettings();
  buffer = new TimelineBuffer(settings.bufferSize);
  mounted = mount(createEvalTransport(), false);

  if (hasExtensionApi()) {
    // A navigation tears down the page-side bridge; restart the handshake so
    // the panel reconnects to the new document instead of going stale.
    extensionApi().devtools?.network?.onNavigated?.addListener(() => {
      mounted?.state.clearTimeline();
      mounted?.client.resetHandshake('page navigated');
    });
  }

  if (settings.preferLiveStreaming) {
    const origin = await inspectedOrigin();
    if (origin && (await extensionApi().permissions.contains({ origins: [`${origin}/*`] }))) {
      // Already granted for this site: no gesture needed.
      await upgradeToLiveStreaming();
    }
  }
};

void start();
