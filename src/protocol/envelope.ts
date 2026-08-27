/**
 * Envelopes for the *internal* hop of the port transport
 * (panel ⇄ background ⇄ content script).
 *
 * The bridge protocol itself is carried as an opaque `payload`; these
 * envelopes only describe routing. Every panel → background envelope after
 * the handshake carries the session `token` the background issued, so a
 * message that did not come from the panel this port belongs to is dropped
 * rather than routed into someone's page.
 *
 * @module protocol/envelope
 */

/** Port name the panel connects with; the background rejects any other. */
export const PANEL_PORT_NAME = 'bquery-devtools-panel';

/** Discriminator shared by every internal envelope. */
export const ENVELOPE_SOURCE = 'bquery-devtools-internal' as const;

/** Panel → background: claim the inspected tab and open the route. */
export interface AttachEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'attach';
  tabId: number;
}

/** Background → panel: the route is open; here is the session token. */
export interface AttachedEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'attached';
  token: string;
  tabId: number;
}

/** Background → panel: the route could not be opened. */
export interface AttachFailedEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'attach-failed';
  reason: string;
}

/** Panel → background → content script: one bridge message for the page. */
export interface ToPageEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'to-page';
  token: string;
  payload: unknown;
}

/** Content script → background → panel: one bridge message from the page. */
export interface FromPageEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'from-page';
  payload: unknown;
}

/** Panel → background: (re)inject the content script into the inspected tab. */
export interface InjectEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'inject';
  token: string;
}

/** Background → panel: result of an {@link InjectEnvelope}. */
export interface InjectResultEnvelope {
  source: typeof ENVELOPE_SOURCE;
  type: 'inject-result';
  ok: boolean;
  reason?: string;
}

/** Anything the panel sends over its port. */
export type PanelEnvelope = AttachEnvelope | ToPageEnvelope | InjectEnvelope;

/** Anything the background sends back over a panel port. */
export type BackgroundEnvelope =
  AttachedEnvelope | AttachFailedEnvelope | FromPageEnvelope | InjectResultEnvelope;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Narrow an untrusted value to a panel → background envelope. */
export const parsePanelEnvelope = (value: unknown): PanelEnvelope | null => {
  if (!isRecord(value) || value['source'] !== ENVELOPE_SOURCE) return null;
  switch (value['type']) {
    case 'attach':
      return typeof value['tabId'] === 'number'
        ? { source: ENVELOPE_SOURCE, type: 'attach', tabId: value['tabId'] }
        : null;
    case 'to-page':
      return typeof value['token'] === 'string'
        ? {
            source: ENVELOPE_SOURCE,
            type: 'to-page',
            token: value['token'],
            payload: value['payload'],
          }
        : null;
    case 'inject':
      return typeof value['token'] === 'string'
        ? { source: ENVELOPE_SOURCE, type: 'inject', token: value['token'] }
        : null;
    default:
      return null;
  }
};

/** Narrow an untrusted value to a background → panel envelope. */
export const parseBackgroundEnvelope = (value: unknown): BackgroundEnvelope | null => {
  if (!isRecord(value) || value['source'] !== ENVELOPE_SOURCE) return null;
  switch (value['type']) {
    case 'attached':
      return typeof value['token'] === 'string' && typeof value['tabId'] === 'number'
        ? {
            source: ENVELOPE_SOURCE,
            type: 'attached',
            token: value['token'],
            tabId: value['tabId'],
          }
        : null;
    case 'attach-failed':
      return {
        source: ENVELOPE_SOURCE,
        type: 'attach-failed',
        reason: typeof value['reason'] === 'string' ? value['reason'] : 'unknown error',
      };
    case 'from-page':
      return { source: ENVELOPE_SOURCE, type: 'from-page', payload: value['payload'] };
    case 'inject-result':
      return {
        source: ENVELOPE_SOURCE,
        type: 'inject-result',
        ok: value['ok'] === true,
        ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
      };
    default:
      return null;
  }
};

/** Narrow an untrusted value to a content-script → background envelope. */
export const parseContentEnvelope = (value: unknown): FromPageEnvelope | null => {
  if (!isRecord(value) || value['source'] !== ENVELOPE_SOURCE) return null;
  if (value['type'] !== 'from-page') return null;
  return { source: ENVELOPE_SOURCE, type: 'from-page', payload: value['payload'] };
};
