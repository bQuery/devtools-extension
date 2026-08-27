# Publishing

The extension versions independently of `@bquery/bquery`: store review is slow
and unpredictable, and the bridge protocol — not the release train — is what
keeps the two compatible.

## Versioning

`app.config.json` is the single source of truth. `bun run sync` copies its
`AppData.version` into `package.json` and `public/manifest.json`, and every
`deploy-*` script runs `sync` first.

To cut a release:

```bash
# 1. bump AppData.version in app.config.json (semver, e.g. 1.1.0)
bun run sync
# 2. update CHANGELOG.md
git commit -am "chore: release 1.1.0"
git tag v1.1.0
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which validates, builds both
targets, verifies and packages them, signs what can be signed (see
[Signing](#signing)), writes `SHA256SUMS.txt` and opens a **draft** GitHub
release with the artifacts attached. Review it, then publish.

Store manifests must use a numeric `major.minor.patch[.build]` version. Do not
put pre-release suffixes (`1.1.0-beta.1`) in `AppData.version`; use a build
segment (`1.1.0.1`) if you need one.

## Building locally

```bash
bun run deploy-v3 && bun run verify && bun run package   # chromium-mv3
bun run deploy-v2 && bun run verify && bun run package   # firefox-mv2
```

Both zips land in `artifacts/`. `bun run verify` is not optional — it catches
a missing entry point, an unreplaced branding token, a content script that
accidentally became an ES module, and host permissions creeping back in.

## Signing

Browser extensions are not signed the way a binary is — each store signs what
it distributes, so what a release workflow can produce differs per target.

### Build provenance (always)

Every release attests its artifacts with
[`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance),
which signs a provenance statement through Sigstore. No secrets are involved,
so it runs on every release. Anyone can check which workflow, commit and runner
produced a given file:

```bash
gh attestation verify bquery-devtools-1.0.0-chromium-mv3.zip \
  --repo bQuery/devtools-extension
```

This is the guarantee that actually matters for a store-distributed extension:
it ties the zip you are about to upload to the commit it was built from.

### Firefox / AMO (when credentials are configured)

AMO is the only party that can produce an installable, signed Firefox artifact
— signing there is a service, not a local key operation. When the repository
has `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`
([API credentials](https://addons.mozilla.org/developers/addon/api/key/))
configured as secrets, the workflow runs `web-ext sign --channel unlisted` and
attaches the resulting signed `.xpi` to the release.

Without those secrets the step is **skipped, not failed**: the release still
ships the unsigned MV2 zip for manual upload through the AMO dashboard. Use the
signed `.xpi` for self-distribution; a listed AMO release is signed by AMO on
upload either way.

### Chrome / Edge

There is nothing to sign locally. The Chrome Web Store re-signs every upload
with its own key and assigns the extension id, so a self-signed CRX would be
discarded. Self-hosted CRX distribution is a different (and much rarer)
workflow that needs a private key this repository deliberately does not carry —
if you need it, keep the key outside CI.

## Chrome Web Store

1. Sign in to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   with the account that owns the listing.
2. **Upload new package** → `artifacts/bquery-devtools-<version>-chromium-mv3.zip`.
3. Check the listing fields (they change less often than the code):
   - *Category*: Developer Tools.
   - *Screenshots*: the panel on a page running a bQuery app — component tree,
     signals, and timeline are the three that matter.
   - *Privacy*: be precise here, because "collects nothing" is the wrong
     answer. Chrome Web Store policy counts **website content** as user data,
     and the panel reads plenty of it — the component tree, signal and store
     values, and timeline entries from the inspected page. What the extension
     does *not* do is send any of it anywhere: everything stays in the DevTools
     process on the user's machine, there is no remote endpoint, and the only
     thing written to `chrome.storage.local` is the panel's own preferences
     (buffer size, poll interval, live-streaming toggle). Declare handling of
     website content, declare no transmission, and answer the certification
     questions accordingly — the extension neither sells data nor uses it for
     anything beyond the panel's displayed purpose.
4. Justify the permissions. Reviewers ask about these two:
   - `scripting` — "injects a small relay into the inspected tab, only after
     the user explicitly enables live streaming and grants that site's origin";
   - the optional host permission — "requested at runtime for one origin at a
     time; the extension declares no host permissions and works without any".
5. Submit. Review typically takes a few days; a permission change resets it.

Edge Add-ons accepts the same MV3 zip through
[Partner Center](https://partner.microsoft.com/dashboard/microsoftedge).

## Firefox Add-ons (AMO)

1. Build the MV2 target — `browser_specific_settings.gecko.id` comes from
   `AppData.firefox.geckoId` in `app.config.json` and must stay stable across
   releases, or AMO treats the upload as a different add-on.
2. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
   and upload `artifacts/bquery-devtools-<version>-firefox-mv2.zip`.
3. AMO requires reviewable sources for a bundled build. Provide the repository
   tag plus these build instructions:

   ```bash
   bun install --frozen-lockfile
   bun run deploy-v2
   ```

   Note the Bun version from `mise.toml` in the source-upload notes.
4. Self-distribution (unlisted signing) uses the same zip via `web-ext sign` if
   you need a signed build outside AMO.

## After publishing

- Verify the published version loads in a clean profile in both browsers.
- Confirm the panel connects to a page running `connectDevtoolsBridge()`, and
  that **Enable live streaming** still prompts for the origin permission — a
  store-side permission change can silently alter that prompt.
- Move the release notes from *Unreleased* in `CHANGELOG.md`.
