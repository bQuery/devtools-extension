# Architecture

## The shape of the problem

A DevTools panel and the page it inspects live in different worlds. The page
runs the app (and the bQuery bridge); the panel runs in the DevTools window.
Everything between them is a message channel with an untrusted party on one
end.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ inspected page                                                      │
│   app code → connectDevtoolsBridge()  ← the stable contract (v1)    │
└───────────────▲───────────────────────────────────┬─────────────────┘
                │ window.postMessage                │
   ┌────────────┴─────────────┐        ┌────────────▼───────────────┐
   │ EvalTransport (default)  │        │ content.js relay (opt-in)  │
   │ inspectedWindow.eval     │        │ chrome.runtime             │
   └────────────┬─────────────┘        └────────────┬───────────────┘
                │                                   │ port + session token
                │                       ┌───────────▼───────────────┐
                │                       │ background/router.ts      │
                │                       └───────────┬───────────────┘
   ┌────────────▼───────────────────────────────────▼───────────────┐
   │ BridgeClient — handshake, capabilities, request/response,      │
   │                timeouts, reconnection                          │
   └────────────────────────────┬───────────────────────────────────┘
   ┌────────────────────────────▼───────────────────────────────────┐
   │ PanelState — signals, stores, tree, timeline buffer,           │
   │              time-travel reconstruction                        │
   └────────────────────────────┬───────────────────────────────────┘
   ┌────────────────────────────▼───────────────────────────────────┐
   │ Web Components — <bq-panel>, <bq-component-tree>,              │
   │ <bq-inspector>, <bq-timeline>, <bq-value>, <bq-status-bar>     │
   └────────────────────────────────────────────────────────────────┘
```

## Layers

| Layer          | Module                        | Responsibility                                        |
| -------------- | ----------------------------- | ----------------------------------------------------- |
| Protocol       | `src/protocol/messages.ts`    | Message shapes, builders, and validation of page input |
| Protocol       | `src/protocol/results.ts`     | Validation of method *results*                         |
| Protocol       | `src/protocol/client.ts`      | Handshake, capabilities, request correlation, timeouts |
| Transport      | `src/transports/*.ts`         | Two ways to move bytes between panel and page          |
| Routing        | `src/background/router.ts`    | Tab-scoped, token-checked routing for the port transport |
| State          | `src/panel/*.ts`              | Buffering, filtering, time travel, preferences         |
| View           | `src/panel/components/*.ts`   | Custom elements rendering from panel state             |

Each layer only knows the one below it. The views never talk to a transport;
the client never touches the DOM; the protocol modules have no browser
dependencies at all, which is why most of them are unit-testable without a DOM.

## The protocol is imported, not copied

`src/protocol/messages.ts` declares the version and capability list using
`typeof import('@bquery/bquery/devtools')` type queries:

```ts
export const BRIDGE_PROTOCOL_VERSION:
  typeof import('@bquery/bquery/devtools').BRIDGE_PROTOCOL_VERSION = 1;
```

This is a type-only reference, so the framework's page-side bridge runtime is
never bundled into the extension — but if upstream bumps the protocol or
changes the capability union, this repository fails to compile. The contract is
enforced by the type-checker rather than by a comment.

## Two transports, one interface

Both implement `BridgeTransport` (`start` / `send` / `dispose` plus a status
callback), so `BridgeClient` is unaware of which one it drives.

**`EvalTransport` (default).** A DevTools panel may evaluate expressions in the
page it inspects without any host permission. The transport evaluates a small
expression that installs a `message` listener buffering page-channel bridge
messages into an array, and returns (and clears) that array as JSON. The
install is idempotent and re-runs on every poll, which makes the transport
self-healing across navigations. Outbound messages are evaluated as
`window.postMessage(JSON.parse("…"), '*')` — the message is *data* inside the
expression, never source.

**`PortTransport` (opt-in).** A long-lived `chrome.runtime` port to the
background worker, which relays to a content script injected into the inspected
tab. Push instead of poll, at the cost of one per-site permission. MV3 service
workers are evicted aggressively, so a dropped port reconnects with backoff and
re-attaches; the client re-runs the handshake on the fresh route.

## Routing and its trust boundaries

One background worker serves every open panel, so `BridgeRouter` keys its table
by inspected tab id and enforces two rules:

- **panel → page**: forwarded only to the tab that port attached to, and only
  when the envelope carries the session token the router issued on attach. A
  message that arrives without the token — or with another port's — is dropped.
- **page → panel**: routed by `sender.tab.id`, which the browser fills in and a
  page script cannot forge, and only to the panel registered for that tab.

The token is defence in depth, not the primary boundary (that is the browser's
own port isolation): it means a stray message inside the extension's own
message space cannot steer another panel's route.

## Untrusted input

Everything arriving from the page is attacker-controlled — a hostile page can
name a component `<img src=x onerror=…>` or return a cyclic value. Three rules
hold throughout:

1. **Validate, don't cast.** `parseOutbound` and the `results.ts` parsers narrow
   unknown input, dropping malformed members instead of rendering them. Tree
   recursion is depth-capped.
2. **Text sinks only.** `panel/dom.ts` sets `textContent`, never `innerHTML`.
   Inline styles go through `style.setProperty`, since the panel's CSP forbids
   `style` attributes.
3. **Bound everything.** Previews are truncated, child lists capped, the
   timeline is a ring buffer, and the in-page relay queue is bounded too.

## Time travel

The bridge exposes primitives, not history: `getSnapshot` is the state *now*
and `event` messages stream what changed after. Time travel is reconstructed in
the panel — the connect-time snapshot is the base, and `panel/timeTravel.ts`
replays recorded events onto it up to a chosen index.

Event payloads are app-defined (`payload?: unknown`), so replay is deliberately
tolerant: it recognizes `{ value }`, `{ next }`, `{ to }` and bare payloads for
signals, and `{ patch }`, `{ state }`, `{ next }` or a plain object for stores.
When a payload cannot be interpreted, the value is reported as *not recorded*
and the previous value is kept — the panel never invents state, and the UI
labels every row as `replayed`, `unchanged` or `not recorded`.

Reconstruction is read-only: nothing is ever written back into the page.

## Build

`vite` builds the module entries (`panel`, `devtools`, `settings`,
`background`). The content script cannot be an ES module, so `tools/content.ts`
bundles it separately with esbuild as a self-contained IIFE. `tools/parse.ts`
substitutes the branding tokens into the HTML pages and links the emitted CSS;
`tools/v2.ts` rewrites the manifest for Firefox (MV2); `tools/verifyBuild.ts`
checks the result is actually loadable before it is packaged.
