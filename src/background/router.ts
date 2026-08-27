/**
 * Message router for the port transport.
 *
 * One background worker serves every open DevTools panel, so the routing
 * table is keyed by inspected tab and the two directions are kept strictly
 * apart:
 *
 * - **panel → page** is only ever forwarded to the tab that panel attached to,
 *   and only when the envelope carries the session token issued to that port;
 * - **page → panel** is only ever forwarded to the port registered for
 *   `sender.tab.id`, which the browser fills in — a page cannot forge it.
 *
 * The logic is written against small structural interfaces instead of the
 * `chrome.*` globals so it can be unit-tested without a browser.
 *
 * @module background/router
 */
import {
  ENVELOPE_SOURCE,
  PANEL_PORT_NAME,
  parseContentEnvelope,
  parsePanelEnvelope,
  type BackgroundEnvelope,
} from '../protocol/envelope';

/** The slice of `chrome.runtime.Port` the router needs. */
export interface RouterPort {
  readonly name: string;
  postMessage(message: BackgroundEnvelope): void;
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
}

/** The slice of `chrome.runtime.MessageSender` the router trusts. */
export interface RouterSender {
  readonly id?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
}

/** Host services the router depends on. */
export interface RouterHost {
  /** Deliver one bridge payload to the content script of `tabId`. */
  sendToTab(tabId: number, payload: unknown): Promise<void>;
  /** (Re)inject the content script into `tabId`. */
  injectContentScript(tabId: number): Promise<void>;
  /** This extension's own id, used to reject foreign senders. */
  readonly extensionId: string;
  /** Random session token generator. */
  createToken(): string;
}

interface Attachment {
  readonly port: RouterPort;
  readonly token: string;
  readonly tabId: number;
}

/** Routes bridge traffic between DevTools panels and inspected tabs. */
export class BridgeRouter {
  private readonly host: RouterHost;
  private readonly byTab = new Map<number, Attachment>();

  constructor(host: RouterHost) {
    this.host = host;
  }

  /** Number of currently attached panels; exposed for tests and diagnostics. */
  public get attachedTabs(): number {
    return this.byTab.size;
  }

  /**
   * Handle one incoming port connection.
   *
   * Ports with a different name belong to another feature (or another
   * extension's page) and are ignored outright.
   */
  public handleConnect(port: RouterPort): void {
    if (port.name !== PANEL_PORT_NAME) return;

    let attachment: Attachment | null = null;

    port.onMessage.addListener((message: unknown) => {
      const envelope = parsePanelEnvelope(message);
      if (!envelope) return;

      if (envelope.type === 'attach') {
        if (attachment) return; // A port attaches exactly once.
        const token = this.host.createToken();
        attachment = { port, token, tabId: envelope.tabId };
        // Last panel wins: reopening DevTools on a tab replaces the old route.
        this.byTab.set(envelope.tabId, attachment);
        port.postMessage({
          source: ENVELOPE_SOURCE,
          type: 'attached',
          token,
          tabId: envelope.tabId,
        });
        return;
      }

      // Everything past `attach` must present the issued token.
      if (!attachment || envelope.token !== attachment.token) return;
      const { tabId } = attachment;

      if (envelope.type === 'inject') {
        void this.host
          .injectContentScript(tabId)
          .then(() => {
            port.postMessage({ source: ENVELOPE_SOURCE, type: 'inject-result', ok: true });
          })
          .catch((error: unknown) => {
            port.postMessage({
              source: ENVELOPE_SOURCE,
              type: 'inject-result',
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }

      void this.host.sendToTab(tabId, envelope.payload).catch(() => {
        // The content script may not be injected (yet). The panel keeps
        // retrying its handshake, so a dropped frame is not fatal.
      });
    });

    port.onDisconnect.addListener(() => {
      if (!attachment) return;
      // Only drop the entry if this port still owns it.
      if (this.byTab.get(attachment.tabId) === attachment) this.byTab.delete(attachment.tabId);
      attachment = null;
    });
  }

  /**
   * Handle one message from a content script.
   *
   * @returns `true` when the message was routed to a panel.
   */
  public handleContentMessage(message: unknown, sender: RouterSender): boolean {
    // `sender.id` is filled in by the browser; a page script cannot set it.
    if (sender.id !== undefined && sender.id !== this.host.extensionId) return false;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return false;
    const envelope = parseContentEnvelope(message);
    if (!envelope) return false;
    const attachment = this.byTab.get(tabId);
    if (!attachment) return false;
    attachment.port.postMessage(envelope);
    return true;
  }
}
