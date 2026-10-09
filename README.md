# pi-cliproxyapi-quota

[![npm version](https://img.shields.io/npm/v/pi-cliproxyapi-quota.svg)](https://www.npmjs.com/package/pi-cliproxyapi-quota)
[![license](https://img.shields.io/npm/l/pi-cliproxyapi-quota.svg)](./LICENSE)

**English** | [中文](#中文说明)

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
| `/quota` | Show every account's quota windows: used %, remaining %, reset countdown. Reuses the five-minute cache and respects rate-limit cooldowns. |
| `Ctrl+Shift+Q` | Same as `/quota`, but works **while the model is streaming** (it's a shortcut, not a queued command). |
| footer `Quota[claude] 5h ━━━━── 64% · 7d ━━━━━━ 95%` | Compact 6-cell **remaining** quota meters for the **current model's credential**, resolved from the live model registry and response trace headers. Ambiguous routes show `auth pending` instead of another account's quota. Filled meters and percentages are green when healthy, yellow at ≤30% left, and red at ≤10%; empty cells, separators, and reset times are dim. Rendered on session load and model switches; upstream quota refreshes every 5 minutes, even while idle, subject to cache/cooldown. |

The quota data path mirrors the EasyCLIProxyAPI control panel exactly: the proxy management API
`POST /v0/management/api-call` proxies each provider's own usage endpoint (e.g. Anthropic
`/api/oauth/usage`, Google `retrieveUserQuotaSummary`) using the stored OAuth credential. These
endpoints report utilization; they do not consume quota. Disabled credentials are skipped.

### Dynamic model and account routing

- The extension reads `GET /v0/management/auth-files` and `GET /v0/management/auth-files/models?name=…` to match the current model against each credential's registered IDs, including aliases and prefixes. Model names and pi provider labels are not used to guess the upstream provider.
- With one matching credential, its quota is shown immediately. With multiple matches (even within one provider), the footer shows e.g. `Quota[claude/antigravity] auth pending (2 accounts)` until a response identifies the account.
- Pi's `after_provider_response` event supplies `X-CPA-TRACE-ID` (`timestamp-auth_index-request_id`). The extension uses that index to select the exact account's cached quota without delaying stream consumption. Multiple accounts of one provider are distinguished by a short auth index in the footer.
- This describes the last safely attributed conversational request, not a permanent account pin: each new request can choose another account. Idle cache-warming callbacks are ignored and do not erase that selection. Selection is cleared for new requests, model changes, and session changes. If the model changes during a run, trace attribution is conservatively skipped until the next run so a delayed old request cannot be assigned to the new model. Quota/model data is cached only in memory and refreshed every five minutes.
- Only models whose `baseUrl` matches the configured proxy receive an automatic quota footer. `/quota` still lists all supported accounts when using a direct provider.
- Older proxies without the trace header can resolve only unique registry matches. Failed/missing registry data shows `routing unavailable`; unknown models/auth indexes show `auth unknown`. Failed quota retrieval keeps that account's last successful values marked `stale`, or shows `n/a` when no data is cached; it never substitutes another account. WebSocket requests do not currently provide this HTTP trace header. Custom pi providers must forward response instrumentation for trace-based selection.

### Request throttling and HTTP 429

- Every account has a five-minute minimum fetch interval and a shared in-flight request. `/quota`, shortcuts, timers, session startup, and duplicate extension loads in the same process reuse this cache rather than sending parallel account requests. Identical `auth_index` entries are deduplicated.
- Model switches only render cached quota and refresh local routing if needed. Missing-auth traces trigger local registry discovery at most once per minute, never a full upstream quota scan. A newly discovered account gets quota on the next scheduled refresh or `/quota`.
- HTTP 429 honors numeric and HTTP-date `Retry-After`, with a minimum five-minute delay. Without a usable header, repeated 429s use exponential backoff (5 → 10 → 20 → 40 → 60 minutes, with jitter; capped at 60 minutes unless `Retry-After` requires longer). No automatic immediate retry is sent.
- An upstream 429 pauses only the affected account; a management HTTP 429 pauses calls to that configured proxy. Last successful values are retained and marked `stale; rate limited`, with a retry countdown.
- Shutdown, direct-provider switches, and connection changes cancel background subscribers. A shared HTTP request is aborted when nobody still needs it; cancelled collections cannot start the next account's request.
- Cache/cooldown state is memory-only and survives `/reload` within the same process; it resets when pi exits. Independent pi processes, live smoke tests, the GUI, and other consumers still contribute to the upstream account's rate limit. Avoid repeated process restarts or live smoke tests while throttled.

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

- **Verified** (tested against live accounts): `claude`, `antigravity` / `gemini`, `kimi`, `codex`, `kiro`.
- **Unverified** (ported from the EasyCLIProxyAPI panel, endpoints + parsers wired but not yet tested
  against a real account): `xai` / `grok`. These are labelled `(unverified)` in the
  output. If one is wrong for your account, please open an issue with the raw response — easy to fix.
- Reads a local management key to call the localhost management API; nothing is sent anywhere except
  your own proxy and each provider's usage endpoint (through that proxy). Disabled credentials are skipped.

## License

MIT

---

## 中文说明

适用于通过 [CLIProxyAPI / EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)
把各 AI 订阅接入 [pi](https://pi.dev) 的用户。它补上了 pi 对反向代理模型不暴露的订阅配额：

- **额度** — 在 pi 里直接看代理持有的**每个 OAuth 提供方**的订阅限额。

支持的提供方：**Claude**、**Antigravity / Gemini Code Assist**、**Kimi**、**Codex**、**Kiro**（已验证），以及
**xAI / Grok**（尽力支持，在真实账号上校准前显示为 `(unverified)`）。

Kiro 订阅使用按月额度（不分 5h/7d 窗口）。`/quota` 显示百分比及具体用量（`已用 / 总额 <单位> · 剩余`），footer 显示紧凑的 `monthly` 额度条。Kiro 额度通过 CLIProxyAPI 原生插件配额接口（`POST /v0/management/quota/fetch`）获取。

### 功能

| 触发 | 作用 |
|---|---|
| `/quota` | 对代理持有的每个凭证，显示其所有配额窗口：已用 %、剩余 %、重置倒计时。 |
| `Ctrl+Shift+Q` | 同 `/quota`，但**模型正在输出时也能按**（快捷键，不会被排队）。 |
| footer `Quota[claude] 5h ━━━━── 64% · 7d ━━━━━━ 95%` | 显示**当前模型**对应服务的 6 格紧凑**剩余额度**条（通过实时模型注册表与响应 trace 识别凭证；多个候选时显示 `auth pending`，不回退到任意账号）。填充条和百分比：剩余 >30% 为绿色、≤30% 为黄色、≤10% 为红色；空格、分隔符和重置时间为暗色。会话加载及模型切换时刷新，此后每 5 分钟自动刷新（空闲时也会刷新）。 |

取数链路与 EasyCLIProxyAPI 控制面板完全一致：代理管理 API `POST /v0/management/api-call`
用存储的 OAuth 凭证代理请求各提供方自己的用量端点（如 Anthropic `/api/oauth/usage`、
Google `retrieveUserQuotaSummary`）。这些端点只报告用量，不消耗额度；禁用的凭证会跳过。

模型到凭证的映射来自 `/v0/management/auth-files/models?name=…`，不再根据模型名称猜测服务商。响应头 `X-CPA-TRACE-ID` 中的 `auth_index` 用于选择实际路由账号的缓存额度；同一服务商的多个账号保持独立。每次新请求、模型切换及会话切换都会清除旧选择。多个候选账号在收到 trace 前显示 `auth pending`；注册表不可用或账号未知时不显示其他账号的额度。自动 footer 仅用于 `baseUrl` 与配置代理匹配的模型，`/quota` 仍显示所有支持的账号。旧代理无 trace 时只能识别唯一候选；WebSocket 当前不提供该 HTTP trace。

额度请求按账号缓存至少 5 分钟，并合并同一进程内的并发请求；`/quota` 和快捷键也遵守缓存及冷却。切换模型不请求上游额度，未知 trace 仅触发每分钟最多一次的本地注册表刷新。HTTP 429 会遵守 `Retry-After`；无有效头时采用 5–60 分钟指数退避。旧额度会保留并标记 `stale; rate limited`。冷却在同一进程 `/reload` 后保留，但不跨进程共享。

### 安装

```bash
pi install npm:pi-cliproxyapi-quota
# 或从 git：
pi install git:github.com/songhuiming2007-coder/pi-cliproxyapi-quota
```

或把本地目录的路径加到 `~/.pi/agent/settings.json`：

```json
{ "extensions": ["/absolute/path/to/pi-cliproxyapi-quota/index.ts"] }
```

安装后 `/reload` 重载 pi。

### 配置

本包不存储任何密钥，运行时解析：

**Base URL**（代理）：`CLIPROXYAPI_BASE_URL` → `~/.pi/agent/cliproxyapi.json` 的 `baseUrl` → `http://127.0.0.1:8317`

**管理密钥**（`/quota` 必需），按顺序：
1. 环境变量 `CLIPROXYAPI_MANAGEMENT_KEY`
2. `~/.pi/agent/cliproxyapi-quota.json` 的 `{ "managementKey": "..." }`
3. EasyCLIProxyAPI GUI 的 `config.toml`（`management-secret-key`），按系统自动定位：
   - macOS：`~/Library/Application Support/com.cpa.gui/config.toml`
   - Linux：`$XDG_CONFIG_HOME/com.cpa.gui/config.toml`
   - Windows：`%APPDATA%\com.cpa.gui\config.toml`

不用 GUI 的话，设置 `CLIPROXYAPI_MANAGEMENT_KEY`（需与代理的 `remote-management.secret-key` 一致）或用上述 JSON 覆盖。

### 范围与限制

- **已验证**（在真实账号上实测）：`claude`、`antigravity` / `gemini`、`kimi`、`codex`、`kiro`。
- **未验证**（按 EasyCLIProxyAPI 面板移植，端点与解析已接但未在真实账号上跑过）：`xai` / `grok`，输出里标 `(unverified)`。若某家在你账号上不对，请带原始返回开 issue，很容易修。
- 仅读取本地管理密钥去调本机管理 API；除了你自己的代理和（经代理的）各提供方用量端点，不向任何地方发送数据；禁用的凭证会跳过。

### 许可证

MIT
