# Contributing

Thanks for helping out. This repository holds the bQuery DevTools browser
extension; the framework itself lives in
[bQuery/bQuery](https://github.com/bQuery/bQuery).

## Setup

```bash
bun install          # Bun 1.3+, see mise.toml
bun run dev          # rebuild dist/ on change
```

Load `dist/` as an unpacked extension (see the README) and reload it from the
browser's extension page after a rebuild.

## Before you push

```bash
bun run validate     # type-check + lint + unit tests
bun run format       # prettier
bun run test:e2e     # Playwright smoke tests (builds dist/ first)
```

CI runs the same checks plus both build targets, so a green `validate` is
usually enough to predict a green pipeline.

If your environment already ships a Chromium that does not match the pinned
Playwright version, point the tests at it:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium bun run test:e2e
```

## House rules

- **TypeScript, strict.** `tsconfig.json` runs with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` and friends. Please don't loosen it locally.
- **The page is untrusted.** Anything crossing the bridge is validated before
  use, and rendered through text sinks — never `innerHTML`. New views should
  build DOM through `panel/dom.ts`.
- **Layering.** Views read `PanelState`; state talks to `BridgeClient`; the
  client drives a `BridgeTransport`. Please don't shortcut across layers.
- **Protocol changes belong upstream.** The wire contract is owned by
  `@bquery/bquery/devtools`. This repository consumes it and pins the version
  through a type query, so a protocol bump shows up here as a compile error —
  handle it deliberately rather than by widening a type.
- **Permissions.** The extension declares no host permissions. A change that
  needs static site access needs a discussion first; `tools/verifyBuild.ts`
  fails the build if `host_permissions` reappears.

## Tests

- **Unit tests** (`bun test`, files in `tests/unit/`) cover the protocol,
  transports, router and panel logic. These modules are deliberately free of
  DOM dependencies so they can be tested directly.
- **E2E tests** (`tests/e2e/`) serve the built `dist/` over http and drive the
  real panel bundle with a mocked `chrome` API and a fixture page that speaks
  protocol v1. Playwright cannot open a real DevTools panel, so this is how the
  UI is covered end to end.

New behaviour needs a test. Bug fixes need the test that would have caught the
bug.

## Commits and pull requests

- Conventional-commit style subjects (`feat:`, `fix:`, `docs:`, `chore:`) keep
  the changelog readable.
- Describe user-visible changes in `CHANGELOG.md` under *Unreleased*.
- Keep pull requests focused; a protocol change and a UI redesign are two pull
  requests.

## Releasing

See [docs/PUBLISHING.md](./docs/PUBLISHING.md).
