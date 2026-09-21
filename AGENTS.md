# pi-cliproxyapi-quota

A pi extension that allows setups routing subscriptions into pi through CLIProxyAPI / EasyCLIProxyAPI to:

1. `/quota`: view subscription **5-hour** and **weekly** quota (and other windows) from
   inside pi. Same data path as the EasyCLIProxyAPI panel: call the proxy management API
   `POST /v0/management/api-call`, which proxies usage endpoints (e.g. Anthropic `/api/oauth/usage`,
   Google `retrieveUserQuotaSummary`) using the stored OAuth credential.

## Layout conventions

- `index.ts` — the whole extension (single source file, loaded as TS by pi).
- No third-party runtime dependencies; only Node built-ins + global `fetch`.
- `@earendil-works/*` are `import type` only (erased at build time, never resolved at runtime),
  so the file also works outside `node_modules`.

## Credential discipline (important)

- The management key (`management-secret-key`) is **never written to any file in this repo**. It is
  resolved at runtime in this order:
  1. env `CLIPROXYAPI_MANAGEMENT_KEY`
  2. `~/.pi/agent/cliproxyapi-quota.json` field `managementKey` (optional override)
  3. EasyCLIProxyAPI GUI `config.toml` `management-secret-key` (default source), located per-OS:
     macOS `~/Library/Application Support/com.cpa.gui/config.toml`,
     Linux `$XDG_CONFIG_HOME/com.cpa.gui/config.toml`,
     Windows `%APPDATA%\com.cpa.gui\config.toml`.
- Base URL resolution: env `CLIPROXYAPI_BASE_URL` → `~/.pi/agent/cliproxyapi.json` `baseUrl` →
  `http://127.0.0.1:8317`.

## Loading during development

Add this directory's `index.ts` absolute path to the `extensions` array in
`~/.pi/agent/settings.json`, then restart pi (or `/reload`).

## Verification

- `node test-quota.mjs` hits the live proxy and prints the rendered quota (also unit-checks the pure
  formatters). Or just `curl` the management API directly.
- Inside pi: `/quota` shows quota output — that's a pass.

## Scope

- Provider registry in `index.ts` (`ADAPTERS`): one adapter per OAuth provider, each with its own
  endpoint / headers / body and a parser that normalizes to `Win { label, remainingPct, resetIso }`.
- **Verified** against live accounts: `claude`, `antigravity` / `gemini`, `kimi`, `codex`.
- **Unverified** (endpoints + parsers ported from the EasyCLIProxyAPI panel, not yet tested on a real
  account, shown as `(unverified)` in output): `xai` / `grok`. To verify one: run its
  request through `POST /v0/management/api-call` with a real credential, compare the raw JSON to the
  adapter's field names, adjust, then flip `verified: true`.
- The management `api-call` request body uses fields `{ authIndex, method, url, header, body }` where
  `body` is a **string** (sending `data` or an object body returns `invalid body`).

## Release

- npm (public, appears in the pi.dev/packages gallery via the `pi-package` keyword) and GitHub git.
- Bump version, push with tags, then `npm publish --otp=<code>` (2FA required):
  `npm version patch && git push --follow-tags && npm publish --otp=<code>`.
