# bQuery DevTools

[![CI](https://github.com/bQuery/devtools-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/bQuery/devtools-extension/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/bQuery/devtools-extension?style=flat-square)](./LICENSE)

A browser DevTools extension for inspecting [bQuery](https://bquery.flausch-code.de)
applications: the **component tree**, live **signal** and **store** values, and
the reactive **timeline** — with time travel over recorded events.

It speaks the stable bridge protocol (**v1**) exported by
`@bquery/bquery/devtools`, and nothing else. The framework and the extension
ship on separate release cadences; the protocol is the contract between them.

## Quick start

1. Enable the bridge in the app you want to inspect:

   ```ts
   import { connectDevtoolsBridge, enableDevtools } from '@bquery/bquery/devtools';

   enableDevtools(true);
   connectDevtoolsBridge(); // exposes protocol v1 over window.postMessage
   ```

   Requires `@bquery/bquery` **≥ 1.15.0**.

2. Install the extension (see [Installing](#installing)).

3. Open DevTools on that page and select the **bQuery** panel.

## Features

- **Component tree** — every custom element on the page, with its attributes,
  filterable by tag or attribute. Clicking a node reveals the real element in
  the Elements panel.
- **Signals & stores** — live values with drill-down into nested objects and
  arrays, plus subscriber counts.
- **Timeline** — reactive events as they happen, with a configurable ring
  buffer, per-type filter chips, free-text search, pause and clear.
- **Time travel** — scrub back through recorded events and see the signal and
  store state as of that moment, reconstructed from the connect-time snapshot.
- **Capability negotiation** — the panel only offers what the page's `init`
  handshake advertises, and says so when something is missing.
- **No host permissions by default** — see [Permissions](#permissions).

## Installing

### From source

```bash
bun install
bun run deploy-v3   # Chromium / Edge (MV3) → dist/
bun run deploy-v2   # Firefox (MV2)         → dist/
```

**Chromium / Edge:** open `chrome://extensions`, enable **Developer mode**,
click **Load unpacked** and pick `dist/`.

**Firefox:** run `bun run deploy-v2`, then open `about:debugging` → **This
Firefox** → **Load Temporary Add-on** and pick `dist/manifest.json`.

`bun run package` writes a store-ready zip to `artifacts/`.

## Permissions

The extension declares **no host permissions**. By default the panel talks to
the page through `chrome.devtools.inspectedWindow.eval`, which a DevTools panel
may use on the page it is inspecting without any site access, and drains
buffered bridge messages on a short poll.

**Enable live streaming** in the panel's status bar upgrades that to a push
transport: the panel asks for permission for the current site only, injects a
small content-script relay, and events arrive as they happen. The permission is
per-site, requested on a click, and revocable from the browser's extension
settings. Everything works without it — you just get polling instead of push.

| Permission                  | Why                                                             |
| --------------------------- | --------------------------------------------------------------- |
| `storage`                   | Panel preferences (buffer size, poll interval). No site access. |
| `scripting`                 | Injecting the relay when you opt into live streaming.           |
| `optional_host_permissions` | Requested at runtime, one origin at a time.                     |

## Security model

The inspected page is treated as untrusted, because it is:

- every message from the page is schema-validated before use, and messages
  from a foreign protocol version are rejected outright;
- every value the panel displays is written through text sinks — the panel
  never assigns page-derived strings to `innerHTML`;
- the panel's CSP forbids inline script and inline style;
- panel → page messages are embedded as JSON _data_ in the evaluated
  expression, never spliced into its source;
- the background router forwards a panel's messages only to the tab that panel
  attached to, and only when they carry the session token it issued.

## Development

```bash
bun install
bun run dev          # rebuild on change
bun run validate     # type-check + lint + unit tests
bun run test         # unit tests (bun test)
bun run test:e2e     # build, then Playwright smoke tests
bun run verify       # sanity-check a built dist/
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for how the pieces fit together.
Publishing is documented in [docs/PUBLISHING.md](./docs/PUBLISHING.md).

## Protocol (v1)

Every message carries `source: 'bquery-devtools'` and the protocol version `v`.

| Direction    | `kind`     | Purpose                                     |
| ------------ | ---------- | ------------------------------------------- |
| panel → page | `hello`    | Announce the panel; the page replies `init` |
| panel → page | `request`  | `{ id, method, params }`                    |
| page → panel | `init`     | `{ capabilities }` handshake                |
| page → panel | `response` | `{ id, result \| error }`                   |
| page → panel | `event`    | One streamed timeline `entry`               |

**Methods:** `ping`, `getSnapshot`, `getTimeline` (`{ limit }`),
`getComponentTree`. Apps can add their own through
`connectDevtoolsBridge({ methods })`; the panel ignores methods it does not
know about.

**Capabilities:** `signals`, `stores`, `components`, `timeline`, `time-travel`.

## Partial bQuery apps

The panel does not require a complete framework on the other end. Capabilities
advertised in the handshake are treated as a hint; each section is graded on
what the page actually answers, and they are fetched independently:

- an app that loaded `reactive` but not `store` shows its signals, and the
  stores view says the page does not report any — not "0 stores";
- a bridge implementing only `getTimeline` still gets a working timeline;
- a bridge that advertises nothing is probed once, and lights up if it answers;
- with no `getComponentTree`, the components view falls back to the flat
  registry the snapshot carries;
- a page speaking a newer protocol version is named as incompatible instead of
  leaving the panel waiting.

A section the page refuses is asked for exactly once per connection. **Refresh
all** re-probes everything, so enabling devtools or mounting your first
component and pressing it is enough — no need to reopen DevTools.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#partial-implementations) for the
full degradation model.

## Credits

Bootstrapped from
[BrowserExtensionTemplate](https://github.com/JosunLP/BrowserExtensionTemplate)
by Jonas Pfalzgraf. Licensed under the [MIT License](./LICENSE).
