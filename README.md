# pi-cliproxyapi-quota

[![npm version](https://img.shields.io/npm/v/pi-cliproxyapi-quota.svg)](https://www.npmjs.com/package/pi-cliproxyapi-quota)
[![license](https://img.shields.io/npm/l/pi-cliproxyapi-quota.svg)](./LICENSE)

**English**

A [pi](https://pi.dev) extension for users who route their AI subscriptions into pi through
[CLIProxyAPI / EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI).

It surfaces subscription limits for reverse-proxied models inside pi:

- **Quota** — see subscription limits for **every OAuth provider** the proxy holds without leaving pi.

Supported providers: **Claude**, **Antigravity / Gemini Code Assist**, **Kimi**, **Codex**, and **Kiro** (verified), plus
**xAI / Grok** (best‑effort, shown as `(unverified)` until confirmed against a real
account — see [Scope](#scope--limitations)).

Kiro subscriptions expose monthly credits rather than 5h/weekly windows. `/quota` displays both percentage and absolute usage (`used / limit <unit> · <remaining> left`), and the footer displays a compact `monthly` meter. Kiro quota is fetched via CLIProxyAPI's native plugin quota API (`POST /v0/management/quota/fetch`).

## Features

| Trigger | What it does |
|---|---|
| `/quota` | Open an interactive overlay with every account's quota windows: used %, remaining %, reset countdown. Claude and Codex also show manual reset counts and expiry dates (GMT+7). Opening reuses the five-minute cache; press **r** for hard refresh, **Esc/q** to close, **↑/↓ or PgUp/PgDn** to scroll. Non-TUI modes retain the notification output. |
| `Ctrl+Shift+Q` | Same as `/quota`, but works **while the model is streaming** (it's a shortcut, not a queued command). |
| footer `claude 5h ━━━━── 64% · 7d ━━━━━━ 95%` | Compact 6-cell **remaining** quota meters for the **current model's credential**, resolved from the live model registry and response trace headers. When multiple accounts can serve the model, all matching accounts are shown one per line; the traced session account is moved to the top and marked `●`, while untraced accounts retain registry order. Mixed-provider candidates include their provider tag. Filled meters and percentages are green when healthy, yellow at ≤30% left, and red at ≤10%; empty cells, separators, and reset times are dim. Shown on its own line directly below pi's default footer lines (the default footer is left untouched; falls back to the shared status line if another extension replaced the footer). Rendered on session load and model switches; upstream quota refreshes every 5 minutes, even while idle, subject to cache/cooldown. |

Claude's **Fable weekly limit** is shown separately as `7-day Fable` below the overall weekly window in `/quota`, even when the selected model is not Fable. When the selected model ID contains `fable`, the footer shows **three** meters: `5h · 7d · Fable`; other models keep the normal two meters. This reads `limits[].kind = weekly_scoped` with `scope.model.display_name` (plus the legacy `iguana_necktie` fallback), without guessing the routing provider from the model name. Both the overall weekly and Fable-specific limits remain visible.

The quota data path mirrors the EasyCLIProxyAPI control panel exactly: the proxy management API
`POST /v0/management/api-call` proxies each provider's own usage endpoint (e.g. Anthropic
`/api/oauth/usage`, Google `retrieveUserQuotaSummary`) using the stored OAuth credential. These
endpoints report utilization; they do not consume quota. Disabled credentials are skipped.

Manual resets are read-only: Claude reads banked grants from `/api/oauth/usage?cedar_ember=1&skip_spend=1`; Codex reads `/backend-api/wham/rate-limit-reset-credits`. These follow the same per-account cache, single-flight, cancellation, and 429 cooldown as quota windows. Expiries are sorted earliest first; Claude grants containing multiple resets show their count. A reset-data failure preserves quota windows and marks cached reset data stale. No reset is consumed. After upgrading with `/reload`, a pre-existing quota-only cache shows `Manual resets: n/a (pending refresh)` until the next permitted refresh; upgrading never bypasses the five-minute interval or an active 429 cooldown. Manual reset parsing is based on the management panel; live verification is pending.

### OpenAI-compatible ch-relay

An enabled OpenAI-compatible entry named **`ch-relay`** is also supported (5h/weekly windows and read-only
manual resets). Requires the ch-relay Python gateway with `GET /_gateway/usage` and
`GET /_gateway/rate-limit-reset-credits` deployed; older gateways return 404 until rebuilt.
The extension discovers its `auth-index`, model aliases and `base-url` via
`GET /v0/management/openai-compatibility`. It calls the gateway through management `api-call`
(from the proxy host), using the origin of `base-url`, not a hardcoded port.
The gateway injects its own Codex OAuth credential; pi never reads that credential or license.

Other OpenAI-compatible entries participate in routing/ambiguity but do not have quota adapters.
The entry name selects the compat adapter, never a model-family guess; a compat entry named `codex`
cannot use the OAuth Codex adapter. Older proxies returning 404 for this registry remain supported.
Routing caches persist only allowlisted metadata, including the credential-free gateway origin.
After deployment, run `/reload` and `/quota`; existing cache/cooldown intervals still apply.

### Dynamic model and account routing

- The extension reads `GET /v0/management/auth-files` and `GET /v0/management/auth-files/models?name=…` to match the current model against each credential's registered IDs, including aliases and prefixes. OpenAI-compatible entries are discovered separately from `GET /v0/management/openai-compatibility`, using their configured model aliases (they are not auth-files). Model names and pi provider labels are not used to guess the upstream provider.
- With one matching credential, its quota is shown immediately. With multiple matches (including multiple accounts from one provider), the footer lists every matching account and uses the registry order until a response identifies the active account.
- Pi's `after_provider_response` event supplies `X-CPA-TRACE-ID` (`timestamp-auth_index-request_id`). The extension uses that index to move the exact account to the top and mark it `●` without delaying stream consumption. Multiple accounts remain separate and are labeled by email, label, or credential filename; mixed providers also show the provider name.
- This describes the last safely attributed conversational request, not a permanent account pin: each new request can choose another account. Idle cache-warming callbacks are ignored and do not erase that selection. Selection is cleared for new requests, model changes, and session changes. If the model changes during a run, trace attribution is conservatively skipped until the next run so a delayed old request cannot be assigned to the new model. Quota/model data is cached in memory and on disk across sessions, and refreshed every five minutes subject to shared admission/cooldown.
- Only models whose `baseUrl` matches the configured proxy receive an automatic quota footer. `/quota` still lists all supported accounts when using a direct provider.
- Older proxies without the trace header can resolve only unique registry matches. Failed/missing registry data shows `routing unavailable`; unknown models/auth indexes show `auth unknown`. Failed quota retrieval keeps that account's last successful values marked `stale`, or shows `n/a` when no data is cached; it never substitutes another account. WebSocket requests do not currently provide this HTTP trace header. Custom pi providers must forward response instrumentation for trace-based selection.

### Request throttling and HTTP 429

- Every account has a five-minute minimum fetch interval shared across pi processes using the same cache directory, proxy URL and management key. `/quota`, shortcuts, timers, session startup, and duplicate extension loads reuse this cache rather than multiplying upstream requests. Identical `auth_index` entries are deduplicated; in-process requests also share a single flight.
- **Manual hard refresh (`r` inside `/quota`)** is the sole spacing exception: it may fetch after **30 seconds since the previous admission** for that account, shared across processes. It still joins in-flight work, respects foreign fetch leases and all 429/`Retry-After`/management cooldowns, and never fetches without admission. A forced fetch starts a new five-minute interval for normal polling. Routing refresh remains throttled to once per minute. Repeated `r` while loading is ignored; a blocked refresh returns cached/pending data with its actual last-update time, not a new success timestamp. Closing the panel cancels only its subscriber; work needed by another subscriber continues.
- Model switches only render cached quota and refresh local routing if needed. Missing-auth traces trigger local registry discovery at most once per minute, never a full upstream quota scan. A newly discovered account gets quota on the next scheduled refresh or `/quota`.
- HTTP 429 honors numeric and HTTP-date `Retry-After`, with a minimum five-minute delay. Without a usable header, repeated 429s use exponential backoff (5 → 10 → 20 → 40 → 60 minutes, with jitter; capped at 60 minutes unless `Retry-After` requires longer). No automatic immediate retry is sent.
- An upstream 429 pauses only the affected account; a management HTTP 429 pauses calls to that configured proxy. Last successful values are retained and marked `stale; rate limited`, with a retry countdown.
- Shutdown, direct-provider switches, and connection changes cancel background subscribers. A shared HTTP request is aborted when nobody still needs it; cancelled collections cannot start the next account's request.
- Cache/cooldown state survives `/reload`, pi exit and restart. Disk state is stored under `~/.pi/agent/cache/cliproxyapi-quota/` (or `$PI_AGENT_DIR/cache/cliproxyapi-quota/`), partitioned by proxy URL and management-key hash. It includes quota windows, manual reset metadata and credential routing labels/emails, **not** management/OAuth secrets or raw auth-file content. Directories use mode 0700 and files 0600 on POSIX.
- Locks cover only short disk transactions, not HTTP. An admission lease is written **before** fetching. Dead-process locks are recovered immediately; abandoned, hung or corrupt locks expire after 10 seconds. Ownership checks and immutable lease-journal revisions prevent a resumed stale writer from erasing a newer admission/cooldown. A session killed mid-fetch still consumes its five-minute automatic admission slot (only an explicit `r` can use the 30-second exception after its fetch lease expires); it cannot strand a permanent lock or cause an immediate retry storm.
- When another process is fetching, readers return existing cached data (or pending, on cold start) without waiting for HTTP. Automatic polling checks disk again after 10 seconds while the 60-second pending lease is active; expiration of that indicator alone does **not** bypass the five-minute interval or a 429 cooldown; explicit `r` remains subject to the rules above.
- Lock contention never permits an unlocked upstream fetch. If the cache filesystem is unavailable/unwritable, the extension silently falls back to in-memory protection; cross-process coordination is then unavailable. Sharing assumes a local filesystem and the same agent directory/proxy/key; independent directories, the GUI, and other consumers still add traffic. Do not delete the cache to bypass an active cooldown or repeatedly run live smoke tests while throttled.

Offline tests in a local checkout: `npm test`. Live quota smoke test: `node test-quota.mjs` or `node test-quota.mjs --model=<model-id>` to inspect routing (usage endpoints only; no model-generation request).

## Install

```bash
pi install npm:pi-cliproxyapi-quota
# or from git:
pi install git:github.com/songhuiming2007-coder/pi-cliproxyapi-quota
```

Or load a local checkout by adding its path to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/absolute/path/to/pi-cliproxyapi-quota/index.ts"] }
```

Reload pi (`/reload`) after installing.

## Configuration

No secrets are stored in this package. At runtime it resolves:

**Base URL** (proxy): `CLIPROXYAPI_BASE_URL` → `~/.pi/agent/cliproxyapi.json` `baseUrl` → `http://127.0.0.1:8317`

**Management key** (required for `/quota`), in order:
1. env `CLIPROXYAPI_MANAGEMENT_KEY`
2. `~/.pi/agent/cliproxyapi-quota.json` → `{ "managementKey": "..." }`
3. EasyCLIProxyAPI GUI `config.toml` (`management-secret-key`), auto‑located per‑OS:
   - macOS: `~/Library/Application Support/com.cpa.gui/config.toml`
   - Linux: `$XDG_CONFIG_HOME/com.cpa.gui/config.toml`
   - Windows: `%APPDATA%\com.cpa.gui\config.toml`

If you don’t run the GUI, set `CLIPROXYAPI_MANAGEMENT_KEY` (must match your proxy's
`remote-management.secret-key`) or the JSON override.

## Scope & limitations

- **Verified** (tested against live accounts): `claude`, `antigravity` / `gemini`, `kimi`, `codex`, `kiro`, and OpenAI-compatible `ch-relay` (including manual resets via its gateway; see prerequisites above).
- **Unverified** (ported from the EasyCLIProxyAPI panel, endpoints + parsers wired but not yet tested
  against a real account): `xai` / `grok`. These are labelled `(unverified)` in the
  output. If one is wrong for your account, please open an issue with the raw response — easy to fix.
- Reads a local management key to call the localhost management API; nothing is sent anywhere except
  your own proxy and each provider's usage endpoint (through that proxy). Disabled credentials are skipped.

## License

MIT
