/**
 * pi-cliproxy-quota
 *
 * View subscription quota for every OAuth provider CLIProxyAPI holds inside pi:
 *  - /quota: show subscription quota for every OAuth provider the proxy holds,
 *    fetched exactly like the EasyCLIProxyAPI panel does via the proxy management
 *    API `POST /v0/management/api-call`. Providers: claude + antigravity/gemini
 *    + kimi + codex (verified), xai (best-effort, marked (unverified)).
 *  - Footer quota display: automatically refreshed at turn start/end.
 *
 * No secrets in source. Management key is read at runtime from env,
 * ~/.pi/agent/cliproxyapi-quota.json, or the GUI config.toml. See AGENTS.md.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------- config resolution ----------

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
const AGENT_DIR = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");

// EasyCLIProxyAPI GUI config.toml candidate locations, per platform.
function guiConfigCandidates(): string[] {
	const home = homedir();
	if (process.platform === "darwin") {
		return [join(home, "Library", "Application Support", "com.cpa.gui", "config.toml")];
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
		return [join(appData, "com.cpa.gui", "config.toml")];
	}
	// linux / other
	const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
	return [join(xdg, "com.cpa.gui", "config.toml")];
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function firstString(...vals: unknown[]): string | undefined {
	for (const v of vals) {
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

export function resolveBaseUrl(): string {
	const fromFile = readJson(join(AGENT_DIR, "cliproxyapi.json"))?.baseUrl;
	return firstString(process.env.CLIPROXYAPI_BASE_URL, fromFile) ?? DEFAULT_BASE_URL;
}

/** Read `management-secret-key = "..."` from the GUI TOML without a TOML dep. */
function readManagementKeyFromToml(): string | undefined {
	for (const path of guiConfigCandidates()) {
		try {
			const text = readFileSync(path, "utf8");
			const m = text.match(/^\s*management-secret-key\s*=\s*"([^"]+)"/m);
			if (m?.[1]) return m[1];
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

export function resolveManagementKey(): string | undefined {
	const override = readJson(join(AGENT_DIR, "cliproxyapi-quota.json"))?.managementKey;
	return firstString(
		process.env.CLIPROXYAPI_MANAGEMENT_KEY,
		override,
		readManagementKeyFromToml(),
	);
}

// ---------- management API ----------

interface AuthFile {
	id: string;
	name: string;
	provider?: string;
	type?: string;
	auth_index?: string;
	disabled?: boolean;
	email?: string;
	label?: string;
	project_id?: string;
}

async function mgmtGet<T>(base: string, key: string, path: string): Promise<T> {
	const res = await fetch(`${base}/v0/management/${path}`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
	return (await res.json()) as T;
}

async function mgmtApiCall(
	base: string,
	key: string,
	body: unknown,
): Promise<{ status_code: number; body: string }> {
	const res = await fetch(`${base}/v0/management/api-call`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`api-call -> HTTP ${res.status}`);
	return (await res.json()) as { status_code: number; body: string };
}

// List every OAuth credential the proxy holds (any provider), enabled only.
async function listCredentials(base: string, key: string): Promise<AuthFile[]> {
	const data = await mgmtGet<{ files?: AuthFile[] }>(base, key, "auth-files");
	return (data.files ?? []).filter(
		(f) => typeof f.auth_index === "string" && f.auth_index.length > 0 && !f.disabled,
	);
}

// Normalize provider name the same way the GUI does.
function providerKey(f: AuthFile): string {
	const raw = (f.provider ?? f.type ?? "").trim().toLowerCase().replace(/_/g, "-");
	if (raw === "x-ai" || raw === "grok") return "xai";
	return raw;
}

// Normalized quota window (remaining-oriented; used = 100 - remaining).
export interface Win {
	label: string;
	remainingPct: number | null;
	resetIso: string | null;
	tag?: string;
	group?: string;
}

function toNum(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
	return Number.isFinite(n) ? n : null;
}

function firstIso(...vals: unknown[]): string | null {
	for (const v of vals) if (typeof v === "string" && v.trim()) return v;
	return null;
}

// Run one upstream request through the management api-call proxy; returns raw body text.
// The proxy substitutes $TOKEN$ in headers with the stored OAuth bearer for authIndex.
async function proxyCall(
	base: string,
	key: string,
	req: { authIndex: string; method: string; url: string; header?: Record<string, string>; body?: string },
): Promise<string> {
	const out = await mgmtApiCall(base, key, req);
	if (out.status_code < 200 || out.status_code >= 300) {
		throw new Error(`upstream HTTP ${out.status_code}`);
	}
	return out.body;
}

const BEARER = { Authorization: "Bearer $TOKEN$" };

interface Adapter {
	verified: boolean;
	fetch: (base: string, key: string, cred: AuthFile) => Promise<Win[]>;
}

// ---- claude (VERIFIED): GET api.anthropic.com/api/oauth/usage ----
const CLAUDE_WINDOWS: Array<[string, string]> = [
	["five_hour", "5-hour (session)"],
	["seven_day", "7-day (weekly)"],
	["seven_day_oauth_apps", "7-day OAuth apps"],
	["seven_day_opus", "7-day Opus"],
	["seven_day_sonnet", "7-day Sonnet"],
	["seven_day_cowork", "7-day Cowork"],
	["iguana_necktie", "7-day Fable"],
];
const claudeAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex,
			method: "GET",
			url: "https://api.anthropic.com/api/oauth/usage",
			header: { ...BEARER, "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
		});
		const usage = JSON.parse(body) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>;
		const wins: Win[] = [];
		for (const [k, label] of CLAUDE_WINDOWS) {
			const w = usage[k];
			if (!w || typeof w !== "object") continue;
			const u = toNum((w as { utilization?: unknown }).utilization);
			if (u === null) continue;
			wins.push({ label, remainingPct: Math.max(0, 100 - u), resetIso: firstIso((w as { resets_at?: unknown }).resets_at) });
		}
		return wins;
	},
};

// ---- antigravity / gemini code assist (VERIFIED): POST retrieveUserQuotaSummary ----
// Mirror the CPA panel: body is {project} (NOT {metadata}), tried across hosts in
// order daily -> daily-sandbox -> prod. The same account reports DIFFERENT quota
// per host environment (e.g. 88% weekly on daily vs 57% on prod); Antigravity
// traffic is served by the daily host, so it is authoritative.
const ANTIGRAVITY_HOSTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
const ANTIGRAVITY_UA = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";

export function parseQuotaSummary(body: string): Win[] {
	const data = JSON.parse(body) as {
		groups?: Array<{ displayName?: unknown; buckets?: Array<Record<string, unknown>> }>;
	};
	const wins: Win[] = [];
	for (const g of data.groups ?? []) {
		const gname = typeof g.displayName === "string" ? g.displayName : "Group";
		for (const b of g.buckets ?? []) {
			const frac = toNum(b.remainingFraction);
			if (frac === null) continue;
			const win = String(b.window ?? "").toLowerCase();
			const tag = win === "5h" ? "5h" : win === "weekly" ? "weekly" : win || "quota";
			wins.push({
				label: `${gname} · ${tag}`,
				remainingPct: Math.max(0, Math.min(100, frac * 100)),
				resetIso: firstIso(b.resetTime),
				group: gname,
			});
		}
	}
	return wins;
}

const antigravityAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const header = { ...BEARER, "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_UA };
		// project id comes from the auth-files listing; discover via loadCodeAssist if absent
		let project = cred.project_id;
		if (!project) {
			try {
				const body = await proxyCall(base, key, {
					authIndex, method: "POST",
					url: `${ANTIGRAVITY_HOSTS[0]}/v1internal:loadCodeAssist`,
					header, body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
				});
				const d = JSON.parse(body) as { cloudaicompanionProject?: unknown };
				const cp = d.cloudaicompanionProject;
				project = typeof cp === "string" ? cp : (cp as { id?: string } | undefined)?.id;
			} catch {
				// fall through to the legacy metadata call below
			}
		}
		if (project) {
			let lastErr: unknown;
			for (const host of ANTIGRAVITY_HOSTS) {
				try {
					const body = await proxyCall(base, key, {
						authIndex, method: "POST",
						url: `${host}/v1internal:retrieveUserQuotaSummary`,
						header, body: JSON.stringify({ project }),
					});
					return parseQuotaSummary(body);
				} catch (err) {
					lastErr = err;
				}
			}
			throw lastErr;
		}
		// no project id (e.g. plain gemini-cli credential): legacy prod-host call
		const body = await proxyCall(base, key, {
			authIndex,
			method: "POST",
			url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
			header,
			body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
		});
		return parseQuotaSummary(body);
	},
};

// ---- kimi (VERIFIED): GET api.kimi.com/coding/v1/usages ----
// Real shape: top-level `usage` = weekly quota; `limits[].detail` = per-window quota
// with `limits[].window.{duration,timeUnit}` (e.g. 300 minutes = the 5h window).
const kimiAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex, method: "GET", url: "https://api.kimi.com/coding/v1/usages", header: { ...BEARER },
		});
		const data = JSON.parse(body) as {
			usage?: Record<string, unknown>;
			limits?: Array<{ window?: { duration?: unknown; timeUnit?: unknown }; detail?: Record<string, unknown> }>;
		};
		const wins: Win[] = [];
		const push = (label: string, d: Record<string, unknown> | undefined): void => {
			const remaining = toNum(d?.remaining);
			const limit = toNum(d?.limit);
			if (remaining === null || limit === null || limit <= 0) return;
			wins.push({
				label,
				remainingPct: Math.max(0, Math.min(100, (remaining / limit) * 100)),
				resetIso: firstIso(d?.resetTime, d?.reset_at, d?.resetAt, d?.reset_time),
			});
		};
		push("weekly", data.usage);
		for (const l of data.limits ?? []) {
			const mins = String(l.window?.timeUnit ?? "").includes("MINUTE") ? toNum(l.window?.duration) : null;
			const label = mins === null ? "window" : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
			push(label, l.detail);
		}
		return wins;
	},
};

// ---- codex (VERIFIED): GET chatgpt.com/backend-api/wham/usage ----
export function codexWindowLabel(slot: string, winSecs: number | null): string {
	if (winSecs !== null && winSecs > 0) {
		if (winSecs === 18_000) return "5h";
		if (winSecs === 604_800) return "weekly";
		if (winSecs % 86_400 === 0) {
			const d = winSecs / 86_400;
			return d === 7 ? "weekly" : `${d}d`;
		}
		if (winSecs % 3_600 === 0) return `${winSecs / 3_600}h`;
		if (winSecs % 60 === 0) return `${winSecs / 60}m`;
		return `${winSecs}s`;
	}
	if (slot === "primary") return "5h";
	if (slot === "secondary") return "weekly";
	return slot;
}

export function parseCodexUsage(body: string, now = Date.now()): Win[] {
	const data = JSON.parse(body) as Record<string, unknown>;
	const wins: Win[] = [];
	let rl = data.rate_limit as Record<string, unknown> | undefined;
	if (!rl || typeof rl !== "object") {
		rl = (data.rate_limits ?? data) as Record<string, unknown>;
	}
	const limitReached = rl.limit_reached === true || rl.limitReached === true || rl.allowed === false;
	for (const [slot, legacy] of [
		["primary_window", "primary"],
		["secondary_window", "secondary"],
	] as const) {
		const r = (rl[slot] ?? rl[legacy]) as Record<string, unknown> | null | undefined;
		if (!r || typeof r !== "object") continue;
		const up = toNum(r.used_percent ?? r.usedPercent);
		if (up === null) continue;
		const secs = toNum(
			r.reset_after_seconds ??
			r.resets_in_seconds ??
			r.resetsInSeconds ??
			r.resetAfterSeconds,
		);
		let resetIso: string | null = null;
		if (secs !== null && secs >= 0) {
			resetIso = new Date(now + secs * 1000).toISOString();
		} else {
			const at = r.reset_at ?? r.resets_at ?? r.resetAt ?? r.resetsAt;
			const atNum = toNum(at);
			if (atNum !== null && atNum > 0) {
				const ms = atNum < 1e11 ? atNum * 1000 : atNum;
				resetIso = new Date(ms).toISOString();
			} else {
				resetIso = firstIso(at);
			}
		}
		const winSecs = toNum(r.limit_window_seconds ?? r.limitWindowSeconds);
		const slotName = slot.replace(/_window$/, "");
		const label = codexWindowLabel(slotName, winSecs);
		const winLimitReached =
			r.limit_reached === true ||
			r.limitReached === true ||
			r.allowed === false ||
			(limitReached && up >= 100);
		const tag = winLimitReached ? "limit reached" : undefined;
		wins.push({
			label,
			remainingPct: Math.max(0, 100 - up),
			resetIso,
			...(tag ? { tag } : {}),
		});
	}
	if (limitReached && wins.length > 0 && !wins.some((w) => w.tag)) {
		wins[0].tag = rl.allowed === false && rl.limit_reached !== true ? "blocked" : "limit reached";
	}
	const credsObj = (typeof data.credits === "object" && data.credits !== null ? data.credits : {}) as Record<string, unknown>;
	const bp = toNum(
		data.creditUsagePercent ??
		data.credit_usage_percent ??
		data.usagePercent ??
		data.usage_percent ??
		credsObj.used_percent ??
		credsObj.usedPercent,
	);
	if (bp !== null) {
		const cp = (data.currentPeriod ?? data.current_period) as Record<string, unknown> | undefined;
		const credsLimitReached = credsObj.overage_limit_reached === true || bp >= 100;
		wins.push({
			label: "credits",
			remainingPct: Math.max(0, 100 - bp),
			resetIso: firstIso(cp?.end),
			...(credsLimitReached ? { tag: "limit reached" } : {}),
		});
	}
	return wins;
}

const codexAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex,
			method: "GET",
			url: "https://chatgpt.com/backend-api/wham/usage",
			header: {
				...BEARER,
				"Content-Type": "application/json",
				"User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
			},
		});
		return parseCodexUsage(body);
	},
};

// ---- xai / grok (UNVERIFIED): GET api.x.ai/v1/me (mostly account health) ----
const xaiAdapter: Adapter = {
	verified: false,
	async fetch(base, key, cred) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex, method: "GET", url: "https://api.x.ai/v1/me", header: { ...BEARER, accept: "application/json" },
		});
		const data = JSON.parse(body) as Record<string, unknown>;
		const p = toNum(data.usagePercent ?? data.usage_percent ?? data.creditUsagePercent);
		return p === null ? [] : [{ label: "usage", remainingPct: Math.max(0, 100 - p), resetIso: null }];
	},
};

const ADAPTERS: Record<string, Adapter> = {
	claude: claudeAdapter,
	antigravity: antigravityAdapter,
	gemini: antigravityAdapter,
	kimi: kimiAdapter,
	codex: codexAdapter,
	xai: xaiAdapter,
};

/** Guess which quota provider the current pi model routes to (by provider/id text). */
export function providerFromModel(model: { provider?: string; id?: string } | undefined): string | null {
	const s = `${model?.provider ?? ""} ${model?.id ?? ""}`.toLowerCase();
	if (s.includes("claude")) return "claude";
	if (s.includes("gemini") || s.includes("antigravity")) return "antigravity";
	if (s.includes("codex") || s.includes("gpt")) return "codex";
	if (s.includes("kimi")) return "kimi";
	if (s.includes("grok") || s.includes("xai")) return "xai";
	return null;
}

/** Fetch and render quota for every known credential. Exported for test-quota.mjs. */
export async function collectQuota(
	base: string,
	key: string,
	now = Date.now(),
	prefer?: string | null,
	theme?: FooterTheme,
	model?: { provider?: string; id?: string } | string | null,
): Promise<{ blocks: string[]; footer: string }> {
	const creds = await listCredentials(base, key);
	const known = creds
		.filter((c) => ADAPTERS[providerKey(c)])
		.sort((a, b) => (providerKey(a) === "claude" ? 0 : 1) - (providerKey(b) === "claude" ? 0 : 1));
	if (known.length === 0) throw new Error("NO_CRED");
	const blocks: string[] = [];
	const summaries = new Map<string, string>(); // providerKey -> one-line summary
	for (const c of known) {
		const pk = providerKey(c);
		const adapter = ADAPTERS[pk];
		const who = c.email || c.label || c.name;
		const tag = adapter.verified ? "" : " (unverified)";
		try {
			const wins = await adapter.fetch(base, key, c);
			blocks.push(`● ${who} [${pk}]${tag}`);
			blocks.push(...renderWindows(wins, now));
			const s = summaryFromWins(wins, now, theme, model);
			if (s !== "Quota n/a" && !summaries.has(pk)) summaries.set(pk, s);
		} catch (err) {
			blocks.push(`● ${who} [${pk}]${tag}\n  failed: ${(err as Error).message}`);
		}
	}
	// Footer follows the current model's provider; fall back to the first available.
	// Tag the provider whenever it is not the current model's (or when several exist),
	// so a fallback never masquerades as the active provider's quota.
	const actual = prefer && summaries.has(prefer) ? prefer : [...summaries.keys()][0];
	const hit = actual !== undefined ? summaries.get(actual) : undefined;
	const footer =
		hit && actual
			? (summaries.size > 1 || actual !== prefer
				? hit.replace("Quota ", `Quota[${actual}] `)
				: hit)
			: "";
	return { blocks, footer };
}

// ---------- rendering ----------

export function formatReset(iso: string | null, now = Date.now()): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "—";
	let ms = t - now;
	if (ms <= 0) return "resets now";
	const days = Math.floor(ms / 86_400_000);
	ms -= days * 86_400_000;
	const hours = Math.floor(ms / 3_600_000);
	ms -= hours * 3_600_000;
	const minutes = Math.floor(ms / 60_000);
	if (days > 0) return `resets in ${days}d ${hours}h`;
	if (hours > 0) return `resets in ${hours}h ${minutes}m`;
	return `resets in ${minutes}m`;
}

function bar(pct: number, width = 12): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Build display lines for one credential's normalized windows. */
export function renderWindows(wins: Win[], now = Date.now()): string[] {
	if (wins.length === 0) return ["  (no quota window data)"];
	return wins.map((w) => {
		const remain = w.remainingPct;
		const tagStr = w.tag ? ` · ${w.tag}` : "";
		if (remain === null) return `  ${w.label.padEnd(22)} n/a · ${formatReset(w.resetIso, now)}${tagStr}`;
		const used = Math.max(0, 100 - remain);
		// suppress when the displayed value rounds to 100%: upstream slides resetTime
		// on untouched buckets (always now+window), so a countdown there is an illusion.
		const resetStr = Math.round(remain) >= 100 ? "—" : formatReset(w.resetIso, now);
		return `  ${w.label.padEnd(22)} ${bar(used)} ${used.toFixed(0)}% used · ${remain.toFixed(0)}% left · ${resetStr}${tagStr}`;
	});
}

function shortTag(label: string): string {
	const l = label.toLowerCase();
	if (l.includes("5h") || l.includes("5-hour") || l.includes("five")) return "5h";
	if (l.includes("weekly") || l.includes("7-day") || l.includes("7d") || l.includes("week")) return "7d";
	return label.split(/[ ·(]/)[0];
}

/** Compact relative reset for the footer: " ↻1h44m", " ↻2d21h" ("" when unknown). */
function compactReset(iso: string | null, now: number): string {
	if (!iso) return "";
	const t = Date.parse(iso);
	if (Number.isNaN(t) || t <= now) return "";
	const ms = t - now;
	const d = Math.floor(ms / 86_400_000);
	const h = Math.floor((ms % 86_400_000) / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	if (d > 0) return ` ↻${d}d${h}h`;
	if (h > 0) return ` ↻${h}h${m}m`;
	return ` ↻${m}m`;
}

type FooterColor = "dim" | "success" | "warning" | "error";

/** Minimal structural type so the pure formatter works without a runtime pi import. */
interface FooterTheme {
	fg(color: FooterColor, text: string): string;
}

function footerTone(remainingPct: number): FooterColor {
	if (remainingPct <= 10) return "error";
	if (remainingPct <= 30) return "warning";
	return "success";
}

function compactMeter(remainingPct: number, theme?: FooterTheme, width = 6): string {
	const filled = Math.round((remainingPct / 100) * width);
	const full = "━".repeat(filled);
	const empty = "─".repeat(width - filled);
	if (!theme) return full + empty;
	return (full ? theme.fg(footerTone(remainingPct), full) : "") + (empty ? theme.fg("dim", empty) : "");
}

function footerWindowRank(label: string): number {
	const tag = shortTag(label);
	if (tag === "5h") return 0;
	if (tag === "7d" || tag === "7h") return 1;
	return 2;
}

export function selectBestGroup(
	wins: Win[],
	model?: { provider?: string; id?: string } | string | null,
): string | undefined {
	const groups = [...new Set(wins.map((w) => w.group).filter((g): g is string => Boolean(g)))];
	if (groups.length <= 1) return groups[0];

	const modelStr = (typeof model === "string" ? model : `${model?.provider ?? ""} ${model?.id ?? ""}`).toLowerCase();
	if (modelStr) {
		if (modelStr.includes("claude") || modelStr.includes("gpt")) {
			const match = groups.find((g) => {
				const gl = g.toLowerCase();
				return gl.includes("claude") || gl.includes("gpt");
			});
			if (match) return match;
		}
		if (modelStr.includes("gemini") || modelStr.includes("antigravity")) {
			const match = groups.find((g) => g.toLowerCase().includes("gemini"));
			if (match) return match;
		}
	}

	// Prefer a group that has active usage (< 100% remaining), picking the most-used group
	let bestUsed: { group: string; minRemain: number } | undefined;
	for (const g of groups) {
		const groupWins = wins.filter((w) => w.group === g && w.remainingPct !== null);
		if (groupWins.length === 0) continue;
		const minRemain = Math.min(...groupWins.map((w) => w.remainingPct as number));
		if (minRemain < 100) {
			if (!bestUsed || minRemain < bestUsed.minRemain) {
				bestUsed = { group: g, minRemain };
			}
		}
	}
	if (bestUsed) return bestUsed.group;

	return groups[0];
}

/** Compact one-line remaining-quota meter: 5h, then weekly/7d, then other windows. */
export function summaryFromWins(
	wins: Win[],
	now = Date.now(),
	theme?: FooterTheme,
	model?: { provider?: string; id?: string } | string | null,
): string {
	const chosenGroup = selectBestGroup(wins, model);
	const candidateWins = chosenGroup ? wins.filter((w) => w.group === chosenGroup) : wins;

	const sorted = candidateWins
		.map((w, index) => ({ w, index }))
		.sort((a, b) => footerWindowRank(a.w.label) - footerWindowRank(b.w.label) || a.index - b.index);

	const footerWins: Array<{ w: Win; index: number }> = [];
	const seenTags = new Set<string>();
	for (const item of sorted) {
		const tag = shortTag(item.w.label);
		if (seenTags.has(tag)) continue;
		seenTags.add(tag);
		footerWins.push(item);
		if (footerWins.length >= 2) break;
	}

	if (footerWins.length < 2 && sorted.length > footerWins.length) {
		for (const item of sorted) {
			if (!footerWins.some((f) => f.index === item.index)) {
				footerWins.push(item);
				if (footerWins.length >= 2) break;
			}
		}
	}

	const parts: string[] = [];
	for (const { w } of footerWins) {
		if (w.remainingPct === null) continue;
		const remaining = Math.max(0, Math.min(100, w.remainingPct));
		const rounded = Math.round(remaining);
		const reset = rounded >= 100 ? "" : compactReset(w.resetIso, now);
		const tagStr = w.tag ? ` (${w.tag})` : "";
		const label = shortTag(w.label);
		const value = `${rounded}%`;
		const styledLabel = theme ? theme.fg("dim", `${label} `) : `${label} `;
		const styledValue = theme ? theme.fg(footerTone(remaining), value) : value;
		const styledReset = theme && reset ? theme.fg("dim", reset) : reset;
		const styledTag = theme && tagStr ? theme.fg("dim", tagStr) : tagStr;
		parts.push(`${styledLabel}${compactMeter(remaining, theme)} ${styledValue}${styledReset}${styledTag}`);
	}
	return parts.length ? `Quota ${parts.join(theme ? theme.fg("dim", " · ") : " · ")}` : "Quota n/a";
}

// ---------- extension ----------

function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

export default function (pi: ExtensionAPI): void {
	// Switching models switches the footer to that provider's quota immediately.
	pi.on("model_select", (_e, ctx) => {
		lastFooterFetch = 0;
		refreshFooterThrottled(ctx);
	});

	// ----- /quota -----
	const QUOTA_KEY = "cliproxy-quota";
	let lastFooterFetch = 0;

	async function collectUsage(
		now: number,
		prefer?: string | null,
		theme?: FooterTheme,
		model?: { provider?: string; id?: string } | string | null,
	): Promise<{ blocks: string[]; footer: string }> {
		const base = resolveBaseUrl();
		const key = resolveManagementKey();
		if (!key) throw new Error("NO_KEY");
		return collectQuota(base, key, now, prefer, theme, model);
	}

	// silent=true only refreshes the footer (used for auto-refresh during/after a turn).
	async function runQuota(ctx: ExtensionContext, silent = false): Promise<void> {
		if (!silent) ctx.ui.notify("Fetching quota…", "info");
		try {
			const theme = isPrimaryUiSession(ctx) ? ctx.ui.theme : undefined;
			const { blocks, footer } = await collectUsage(
				Date.now(),
				providerFromModel(ctx.model),
				theme,
				ctx.model,
			);
			if (!silent) ctx.ui.notify(`Subscription quota\n${blocks.join("\n")}`, "info");
			if (footer && isPrimaryUiSession(ctx)) {
				ctx.ui.setStatus(QUOTA_KEY, ctx.ui.theme.fg("dim", footer));
			}
		} catch (err) {
			if (silent) return;
			const msg = (err as Error).message;
			if (msg === "NO_KEY") {
				ctx.ui.notify(
					'Management key not found. Set CLIPROXYAPI_MANAGEMENT_KEY, or write {"managementKey":"..."} to ~/.pi/agent/cliproxyapi-quota.json, or make sure the EasyCLIProxyAPI GUI has a management-secret-key configured.',
					"error",
				);
			} else if (msg === "NO_CRED") {
				ctx.ui.notify(
					"No usable OAuth credential found (claude / codex / antigravity / gemini / kimi / xai).",
					"warning",
				);
			} else {
				ctx.ui.notify(`Failed to fetch quota: ${msg}`, "error");
			}
		}
	}

	// Auto-refresh footer on session load, first turn start, and each turn end.
	// `before_agent_start` does not fire until after the first prompt, so it cannot
	// populate the footer when pi first opens.
	function refreshFooterThrottled(ctx: ExtensionContext): void {
		if (!isPrimaryUiSession(ctx)) return;
		const now = Date.now();
		if (now - lastFooterFetch < 60_000) return;
		lastFooterFetch = now;
		void runQuota(ctx, true);
	}
	pi.on("session_start", (_e, ctx) => refreshFooterThrottled(ctx));
	pi.on("before_agent_start", (_e, ctx) => refreshFooterThrottled(ctx));
	pi.on("agent_settled", (_e, ctx) => refreshFooterThrottled(ctx));

	// Works while streaming: shortcut fetches and shows quota immediately.
	pi.registerShortcut("ctrl+shift+q", {
		description: "Show subscription quota (all OAuth providers)",
		handler: (ctx) => runQuota(ctx),
	});

	pi.registerCommand("quota", {
		description: "Show subscription quota for all OAuth providers (via CLIProxyAPI)",
		handler: async (_args, ctx) => runQuota(ctx),
	});
}
