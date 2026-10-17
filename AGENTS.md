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

## Dynamic routing

- Discover model → credential candidates with `GET /v0/management/auth-files/models?name=<name>` for every enabled credential, including providers without quota adapters. Never infer the routing provider from model-family names or pi provider labels.
- Resolve the selected credential from HTTP response `X-CPA-TRACE-ID` (`timestamp-auth_index-request_id`) through pi's `after_provider_response` event. Store quota windows by `auth_index`, not by provider.
- Multiple candidates, missing discovery, or unknown auth must not fall back to the first account. Model/session changes clear trace selection and invalidate late refreshes. Automatic footer updates require the model endpoint to match the configured proxy.
- Model switches and unknown trace auth refresh local routing only (unknown traces are throttled to once/minute). They must never trigger an upstream quota scan.
- `createQuotaClient` provides in-process single-flight plus cross-process per-auth cache and minimum five-minute request spacing, including manual commands. Preserve successful windows and mark them stale on failure; respect upstream `Retry-After` and exponential 429 backoff. Management HTTP 429 establishes a shared proxy-level cooldown.
- Shared state lives in `${PI_AGENT_DIR || ~/.pi/agent}/cache/cliproxyapi-quota/<scope hash>/` (directories 0700, files 0600). Persist only normalized quota/manual resets and allowlisted routing metadata — never management/OAuth secrets or raw auth-file content. Proxy URL + management-key hash isolate scopes. Tests use `createQuotaClient({ cacheDir: false })` or an isolated temporary directory.
- File locks protect short disk transactions, never HTTP calls. Persist admission leases before HTTP. Recover dead-PID locks immediately and stale/corrupt locks after 10 seconds; ownership checks plus immutable lease-journal revisions fence late stale writers and prevent shortening admission/cooldown. Never fetch unlocked on lock contention; filesystem failure falls back to in-memory protection only. Use a shared local filesystem; independent agent directories/keys and external GUI consumers are not coordinated.
- Lifecycle/connection cancellation must stop later registry/adapter requests, without aborting shared work still needed by another in-process subscriber. Cache/cooldowns survive reload and process restart. Other processes return cached/pending data and poll disk after 10 seconds while a fetch lease is active; a crashed fetch retains five-minute admission spacing even after its 60-second pending lease expires.
- `npm test` runs offline formatter, routing, lifecycle, throttling, cooldown, cancellation, real multi-process and SIGKILL/stale-writer recovery tests; no credentials or live proxy needed. Do not run live quota smoke tests while debugging a 429.

## Verification

- `node test-quota.mjs` hits the live proxy and prints the rendered quota (also unit-checks the pure
  formatters). Or just `curl` the management API directly.
- Inside pi: `/quota` shows quota output — that's a pass.

## Scope

- Provider registry in `index.ts` (`ADAPTERS`): one adapter per OAuth provider, each with its own
  endpoint / headers / body and a parser that normalizes to `Win { label, remainingPct, resetIso }`.
- **Verified** against live accounts: `claude`, `antigravity` / `gemini`, `kimi`, `codex`, `kiro`.
- **Unverified** (endpoints + parsers ported from the EasyCLIProxyAPI panel, not yet tested on a real
  account, shown as `(unverified)` in output): `xai` / `grok`. To verify one: run its
  request through `POST /v0/management/api-call` with a real credential, compare the raw JSON to the
  adapter's field names, adjust, then flip `verified: true`.
- The management `api-call` request body uses fields `{ authIndex, method, url, header, body }` where
  `body` is a **string** (sending `data` or an object body returns `invalid body`). Kiro fetches
  directly from CLIProxyAPI's plugin quota API `POST /v0/management/quota/fetch` with `{ auth_index }`.

## Release

- npm (public, appears in the pi.dev/packages gallery via the `pi-package` keyword) and GitHub git.
- Bump version, push with tags, then `npm publish --otp=<code>` (2FA required):
  `npm version patch && git push --follow-tags && npm publish --otp=<code>`.
