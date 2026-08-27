# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The extension versions independently of `@bquery/bquery`; the bridge protocol
version is what ties the two together.

## [Unreleased]

## [1.0.0]

First release as a standalone repository, rebuilt on
[BrowserExtensionTemplate](https://github.com/JosunLP/BrowserExtensionTemplate).
It replaces the untyped reference scaffold that used to live in the framework's
`extension/` folder.

### Added

- Typed bridge client for protocol **v1** with handshake retry, capability
  negotiation, request/response correlation, per-request timeouts and
  reconnection.
- Component tree with search over tags and attributes, and click-to-reveal in
  the Elements panel.
- Signals and stores inspector with lazy drill-down into nested values.
- Timeline with a configurable ring buffer, type filter chips, free-text
  search, pause and clear.
- Time travel: replay signal and store state as of any recorded event,
  reconstructed from the connect-time snapshot.
- Two transports behind one interface — a permission-free
  `inspectedWindow.eval` poller (default) and an opt-in push transport over an
  injected content script — so the extension ships with **no host permissions**.
- Background router with per-tab isolation and session-token checks.
- Options page for buffer size, poll interval and the live-streaming
  preference.
- Chromium (MV3) and Firefox (MV2) build targets, a build verifier, and store
  packaging.
- Signed releases: Sigstore build-provenance attestation for every artifact
  (verifiable with `gh attestation verify`), plus an optional AMO-signed `.xpi`
  when `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` are configured.
- Unit tests (`bun test`) and Playwright E2E smoke tests, both run in CI along
  with type-check, lint, format check and both build targets.
- Documentation: README, contributing guide, architecture notes and publishing
  guide.

[Unreleased]: https://github.com/bQuery/devtools-extension/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/bQuery/devtools-extension/releases/tag/v1.0.0
