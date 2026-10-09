/**
 * pi-cliproxy-quota
 *
 * View subscription quota for every OAuth provider CLIProxyAPI holds inside pi:
 *  - /quota: show subscription quota for every OAuth provider the proxy holds,
 *    fetched exactly like the EasyCLIProxyAPI panel does via the proxy management
 *    API `POST /v0/management/api-call`. Providers: claude + antigravity/gemini
 *    + kimi + codex + kiro (verified), xai (best-effort, marked (unverified)).
 *  - Footer quota display: automatically refreshed every 5 minutes, even while idle.
 *
 * No secrets in source. Management key is read at runtime from env,
 * ~/.pi/agent/cliproxyapi-quota.json, or the GUI config.toml. See AGENTS.md.
 */

import { createHash } from "node:crypto";
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

export interface AuthFile {
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

type ResponseHeaders = Record<string, string | string[]>;

function retryAfterHeader(headers: Headers | ResponseHeaders | undefined): string | undefined {
	if (headers instanceof Headers) return headers.get("retry-after") ?? undefined;
	const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	return Array.isArray(value) ? value[0] : value;
}

export function retryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
	if (!value?.trim()) return undefined;
	const text = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(text)) {
		const ms = Number(text) * 1000;
		return Number.isFinite(ms) ? Math.min(ms, Math.max(0, 8.64e15 - now)) : undefined;
	}
	const date = Date.parse(text);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

class QuotaHttpError extends Error {
	readonly status: number;
	readonly scope: "upstream" | "management";
	readonly retryAfter?: string;
	constructor(status: number, scope: "upstream" | "management", retryAfter?: string) {
		super(`${scope} HTTP ${status}`);
		this.status = status;
		this.scope = scope;
		this.retryAfter = retryAfter;
	}
}

function requestSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
	signal?.throwIfAborted();
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

async function mgmtGet<T>(base: string, key: string, path: string, signal?: AbortSignal): Promise<T> {
	const res = await fetch(`${base}/v0/management/${path}`, {
		headers: { Authorization: `Bearer ${key}` }, signal: requestSignal(signal, 20_000),
	});
	signal?.throwIfAborted();
	if (!res.ok) throw new QuotaHttpError(res.status, "management", retryAfterHeader(res.headers));
	const data = await res.json();
	signal?.throwIfAborted();
	return data as T;
}

async function mgmtPost<T>(base: string, key: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const res = await fetch(`${base}/v0/management/${path}`, {
		method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body), signal: requestSignal(signal, 20_000),
	});
	signal?.throwIfAborted();
	if (!res.ok) throw new QuotaHttpError(res.status, "management", retryAfterHeader(res.headers));
	const data = await res.json();
	signal?.throwIfAborted();
	return data as T;
}

interface ApiCallResponse { status_code: number; body: string; header?: ResponseHeaders }

async function mgmtApiCall(base: string, key: string, body: unknown, signal?: AbortSignal): Promise<ApiCallResponse> {
	return mgmtPost<ApiCallResponse>(base, key, "api-call", body, signal);
}

// List every OAuth credential the proxy holds (any provider), enabled only.
async function listCredentials(base: string, key: string, signal?: AbortSignal): Promise<AuthFile[]> {
	const data = await mgmtGet<{ files?: AuthFile[] }>(base, key, "auth-files", signal);
	const seen = new Set<string>();
	return (data.files ?? []).filter((f) => {
		if (typeof f.auth_index !== "string" || !f.auth_index || f.disabled || seen.has(f.auth_index)) return false;
		seen.add(f.auth_index);
		return true;
	});
}

// Normalize provider name the same way the GUI does.
function providerKey(f: AuthFile): string {
	const raw = (f.provider ?? f.type ?? "").trim().toLowerCase().replace(/_/g, "-");
	if (raw === "x-ai" || raw === "grok") return "xai";
	if (raw === "kiro-ha") return "kiro";
	return raw;
}

// Normalized quota window (remaining-oriented; used = 100 - remaining).
export interface Win {
	label: string;
	remainingPct: number | null;
	resetIso: string | null;
	tag?: string;
	group?: string;
	used?: number | null;
	limit?: number | null;
	unit?: string;
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
	signal?: AbortSignal,
): Promise<string> {
	const out = await mgmtApiCall(base, key, req, signal);
	if (out.status_code < 200 || out.status_code >= 300) {
		throw new QuotaHttpError(out.status_code, "upstream", retryAfterHeader(out.header));
	}
	return out.body;
}

const BEARER = { Authorization: "Bearer $TOKEN$" };

interface Adapter {
	verified: boolean;
	fetch: (base: string, key: string, cred: AuthFile, signal?: AbortSignal) => Promise<Win[]>;
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
	async fetch(base, key, cred, signal) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex,
			method: "GET",
			url: "https://api.anthropic.com/api/oauth/usage",
			header: { ...BEARER, "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
		}, signal);
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
	async fetch(base, key, cred, signal) {
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
				}, signal);
				const d = JSON.parse(body) as { cloudaicompanionProject?: unknown };
				const cp = d.cloudaicompanionProject;
				project = typeof cp === "string" ? cp : (cp as { id?: string } | undefined)?.id;
			} catch (err) {
				if (signal?.aborted || (err as QuotaHttpError).status === 429) throw err;
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
					}, signal);
					return parseQuotaSummary(body);
				} catch (err) {
					if (signal?.aborted || (err as QuotaHttpError).status === 429) throw err;
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
		}, signal);
		return parseQuotaSummary(body);
	},
};

// ---- kimi (VERIFIED): GET api.kimi.com/coding/v1/usages ----
// Real shape: top-level `usage` = weekly quota; `limits[].detail` = per-window quota
// with `limits[].window.{duration,timeUnit}` (e.g. 300 minutes = the 5h window).
const kimiAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred, signal) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex, method: "GET", url: "https://api.kimi.com/coding/v1/usages", header: { ...BEARER },
		}, signal);
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
	async fetch(base, key, cred, signal) {
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
		}, signal);
		return parseCodexUsage(body);
	},
};

// ---- xai / grok (UNVERIFIED): GET api.x.ai/v1/me (mostly account health) ----
const xaiAdapter: Adapter = {
	verified: false,
	async fetch(base, key, cred, signal) {
		const authIndex = cred.auth_index as string;
		const body = await proxyCall(base, key, {
			authIndex, method: "GET", url: "https://api.x.ai/v1/me", header: { ...BEARER, accept: "application/json" },
		}, signal);
		const data = JSON.parse(body) as Record<string, unknown>;
		const p = toNum(data.usagePercent ?? data.usage_percent ?? data.creditUsagePercent);
		return p === null ? [] : [{ label: "usage", remainingPct: Math.max(0, 100 - p), resetIso: null }];
	},
};

// ---- kiro (VERIFIED): POST /v0/management/quota/fetch ----
export function kiroWindowLabel(groupName: string, windowName: string): string {
	const g = groupName.trim().toLowerCase();
	const w = windowName.trim().toLowerCase();
	if ((g === "credits" || g === "credit" || !g) && (w === "plan" || w === "monthly" || !w)) {
		return "monthly credits";
	}
	if (g === "credits" || g === "credit") {
		return w ? `credits · ${w}` : "monthly credits";
	}
	return w ? `${groupName} · ${windowName}` : groupName || "monthly credits";
}

export function parseKiroUsage(body: string | Record<string, unknown>): Win[] {
	const data = (typeof body === "string" ? JSON.parse(body) : body) as {
		summary?: Array<{ key?: unknown; label?: unknown; value?: unknown; unit?: unknown }>;
		groups?: Array<{ displayName?: unknown; display_name?: unknown; buckets?: Array<Record<string, unknown>> }>;
		error?: unknown;
	};
	if (typeof data.error === "string" && data.error) {
		throw new Error(data.error);
	}
	const summary = data.summary ?? [];
	const wins: Win[] = [];
	let bucketIndex = 0;

	for (const g of data.groups ?? []) {
		const gname = String(g.displayName ?? g.display_name ?? "").trim() || "Credits";
		for (const b of g.buckets ?? []) {
			const frac = toNum(b.remainingFraction ?? b.remaining_fraction);
			let used = toNum(summary.find((s) => s.key === `used_${bucketIndex}`)?.value);
			let limit = toNum(summary.find((s) => s.key === `limit_${bucketIndex}`)?.value);
			let unit = String(
				summary.find((s) => s.key === `used_${bucketIndex}` || s.key === `limit_${bucketIndex}`)?.unit ?? "",
			).trim();

			if ((used === null || limit === null) && typeof b.description === "string") {
				const m = b.description.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)(?:\s+(.+))?\s*$/);
				if (m) {
					if (used === null) used = toNum(m[1]);
					if (limit === null) limit = toNum(m[2]);
					if (!unit && m[3]) unit = m[3].trim();
				}
			}

			let remainingPct: number | null = null;
			if (frac !== null) {
				remainingPct = Math.max(0, Math.min(100, frac * 100));
			} else if (used !== null && limit !== null && limit > 0) {
				remainingPct = Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
			}

			if (remainingPct !== null) {
				const windowName = String(b.window ?? "").trim();
				wins.push({
					label: kiroWindowLabel(gname, windowName),
					remainingPct,
					resetIso: firstIso(b.resetTime, b.reset_time, b.reset),
					group: gname,
					...(used !== null ? { used } : {}),
					...(limit !== null ? { limit } : {}),
					...(unit ? { unit } : {}),
				});
			}
			bucketIndex++;
		}
	}
	return wins;
}

const kiroAdapter: Adapter = {
	verified: true,
	async fetch(base, key, cred, signal) {
		const authIndex = cred.auth_index as string;
		const res = await mgmtPost<Record<string, unknown>>(base, key, "quota/fetch", {
			auth_index: authIndex,
		}, signal);
		return parseKiroUsage(res);
	},
};

const ADAPTERS: Record<string, Adapter> = {
	claude: claudeAdapter,
	antigravity: antigravityAdapter,
	gemini: antigravityAdapter,
	kimi: kimiAdapter,
	codex: codexAdapter,
	xai: xaiAdapter,
	kiro: kiroAdapter,
};

export interface ProxyModel {
	provider?: string;
	id?: string;
	baseUrl?: string;
}

type ModelHint = ProxyModel | string | null | undefined;

export interface CredentialModels {
	credential: AuthFile;
	// null means discovery failed; [] means the registry has no models for this auth.
	modelIds: string[] | null;
}

export interface QuotaStatus {
	checkedAt?: number;
	nextFetchAt?: number;
	error?: string;
	retryAt?: number;
	rateLimited?: boolean;
	stale: boolean;
}

export interface QuotaSnapshot {
	base: string;
	routes: CredentialModels[];
	windows: Map<string, Win[]>; // auth_index -> windows, never merged by provider
	statuses?: Map<string, QuotaStatus>;
}

export type AuthResolution =
	| { kind: "auth"; credential: AuthFile; source: "trace" | "registry" }
	| { kind: "ambiguous"; providers: string[]; count: number }
	| { kind: "unknown"; reason: "model" | "registry" | "auth" };

/** Only attribute a pi model to this proxy when its actual endpoint matches. */
export function isProxyModel(model: ProxyModel | null | undefined, base: string): boolean {
	if (!model?.baseUrl) return false;
	try {
		const endpoint = new URL(model.baseUrl);
		const proxy = new URL(base);
		const host = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			? "loopback" : url.hostname;
		const path = proxy.pathname.replace(/\/$/, "");
		return endpoint.protocol === proxy.protocol && host(endpoint) === host(proxy) &&
			endpoint.port === proxy.port &&
			(endpoint.pathname === path || endpoint.pathname.startsWith(`${path}/`));
	} catch {
		return false;
	}
}

/** Trace format: timestamp-auth_index-request_id. Request IDs may contain hyphens. */
export function authIndexFromHeaders(headers: Record<string, string>): string | null {
	const trace = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-cpa-trace-id")?.[1]?.trim();
	// CLIProxyAPI generates 16-hex stable auth indexes; do not parse request IDs with split("-").
	return trace?.match(/^\d{14}-([a-f\d]{16})-\S+$/i)?.[1] ?? null;
}

async function discoverCredentialModels(base: string, key: string, creds: AuthFile[], signal?: AbortSignal): Promise<CredentialModels[]> {
	return Promise.all(creds.map(async (credential) => {
		try {
			const name = encodeURIComponent(credential.name || credential.id);
			const data = await mgmtGet<{ models?: Array<{ id?: string }> }>(base, key, `auth-files/models?name=${name}`, signal);
			if (!Array.isArray(data.models)) throw new Error("invalid model registry response");
			return { credential, modelIds: data.models.flatMap((m) => typeof m.id === "string" ? [m.id] : []) };
		} catch (err) {
			if (signal?.aborted || (err as QuotaHttpError).status === 429) throw err;
			return { credential, modelIds: null };
		}
	}));
}

/** Resolve candidates from the runtime registry, or the exact last selected auth from a trace. */
export function resolveModelAuth(model: ModelHint, routes: CredentialModels[], selectedAuthIndex?: string | null): AuthResolution {
	const enabled = routes.filter(({ credential }) => !credential.disabled);
	if (selectedAuthIndex) {
		const hit = enabled.find(({ credential }) => credential.auth_index === selectedAuthIndex);
		return hit ? { kind: "auth", credential: hit.credential, source: "trace" } : { kind: "unknown", reason: "auth" };
	}
	const id = (typeof model === "string" ? model : model?.id)?.trim();
	if (!id) return { kind: "unknown", reason: "model" };
	// Never treat a missing/failed registry response as proof that only one auth supports the model.
	if (enabled.some((route) => route.modelIds === null)) return { kind: "unknown", reason: "registry" };
	const matching = (name: string) => enabled.filter((route) => route.modelIds?.includes(name));
	let candidates = matching(id);
	if (!candidates.length) candidates = matching(id.toLowerCase());
	// Match full registered IDs first, then CLIProxyAPI's optional thinking suffix. Preserve prefixes.
	if (!candidates.length) {
		const plain = id.replace(/\([^()]*\)$/, "").trim();
		if (plain !== id) candidates = matching(plain);
	}
	if (!candidates.length) return { kind: "unknown", reason: "model" };
	if (candidates.length === 1) return { kind: "auth", credential: candidates[0].credential, source: "registry" };
	return { kind: "ambiguous", providers: [...new Set(candidates.map(({ credential }) => providerKey(credential)))], count: candidates.length };
}

export function quotaFooter(snapshot: QuotaSnapshot, model: ModelHint, selectedAuthIndex?: string | null, now = Date.now(), theme?: FooterTheme): string {
	const resolved = resolveModelAuth(model, snapshot.routes, selectedAuthIndex);
	if (resolved.kind === "unknown") return resolved.reason === "registry" ? "Quota routing unavailable" : "Quota auth unknown";
	if (resolved.kind === "ambiguous") {
		return `Quota[${resolved.providers.join("/")}] auth pending (${resolved.count} accounts)`;
	}
	const cred = resolved.credential;
	const pk = providerKey(cred);
	const multiple = snapshot.routes.filter((r) => providerKey(r.credential) === pk && !r.credential.disabled).length > 1;
	const label = multiple ? `${pk}:${cred.auth_index?.slice(0, 8)}` : pk;
	const summary = summaryFromWins(snapshot.windows.get(cred.auth_index as string) ?? [], now, theme, model);
	const status = snapshot.statuses?.get(cred.auth_index as string);
	const note = status?.error ? ` · ${status.stale ? "stale; " : ""}${status.rateLimited ? "rate limited" : "refresh failed"}${status.retryAt ? compactReset(new Date(status.retryAt).toISOString(), now) : ""}` : "";
	return summary.replace(/^Quota /, `Quota[${label}] `) + note;
}

const QUOTA_TTL_MS = 5 * 60_000;
const ROUTING_THROTTLE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

interface Flight<T> { controller: AbortController; promise: Promise<T>; users: number }
interface AccountCache {
	windows?: Win[];
	checkedAt?: number;
	retryAt: number;
	failures: number;
	error?: string;
	rateLimited?: boolean;
	flight?: Flight<void>;
}
interface ProxyCache {
	routes?: CredentialModels[];
	routesAt: number;
	routeAttemptAt: number;
	routeRetryAt: number;
	routeError?: Error;
	routeFlight?: Flight<CredentialModels[]>;
	managementUntil: number;
	managementFailures: number;
	managementError?: Error;
	accounts: Map<string, AccountCache>;
}

function scopeId(base: string, key: string): string {
	// Isolate credentials without putting the management secret in cache keys or files.
	return `${base.replace(/\/$/, "")}:${createHash("sha256").update(key).digest("hex")}`;
}

function joinFlight<T>(flight: Flight<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	flight.users++;
	return new Promise((resolve, reject) => {
		let finished = false;
		const finish = (error: unknown, value?: T, aborted = false) => {
			if (finished) return;
			finished = true;
			signal?.removeEventListener("abort", onAbort);
			flight.users--;
			if (aborted && flight.users === 0) flight.controller.abort();
			if (error !== undefined) reject(error);
			else resolve(value as T);
		};
		const onAbort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"), undefined, true);
		signal?.addEventListener("abort", onAbort, { once: true });
		flight.promise.then((value) => finish(undefined, value), (error) => finish(error));
		if (signal?.aborted) onAbort();
	});
}

export interface QuotaClient {
	routing(base: string, key: string, signal?: AbortSignal, refresh?: boolean): Promise<CredentialModels[]>;
	snapshot(base: string, key: string, routes: CredentialModels[]): QuotaSnapshot;
	collect(base: string, key: string, now?: number, signal?: AbortSignal): Promise<{ blocks: string[]; snapshot: QuotaSnapshot }>;
}

/** Separate local routing discovery from rate-limited upstream quota, with per-auth admission control. */
export function createQuotaClient(
	options: { now?: () => number; random?: () => number } = {},
	caches = new Map<string, ProxyCache>(),
): QuotaClient {
	const clock = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	const cacheFor = (base: string, key: string): ProxyCache => {
		const id = scopeId(base, key);
		let cache = caches.get(id);
		if (!cache) {
			cache = { routesAt: 0, routeAttemptAt: -Infinity, routeRetryAt: 0, managementUntil: 0, managementFailures: 0, accounts: new Map() };
			caches.set(id, cache);
		}
		return cache;
	};
	const backoff = (failures: number) => Math.min(MAX_BACKOFF_MS, QUOTA_TTL_MS * 2 ** Math.min(8, failures - 1) * (1 + random() * 0.2));
	const managementFailure = (cache: ProxyCache, error: QuotaHttpError) => {
		if (error.scope !== "management" || error.status !== 429) return;
		cache.managementFailures++;
		cache.managementError = error;
		cache.managementUntil = Math.max(cache.managementUntil, clock() + Math.max(backoff(cache.managementFailures), retryAfterMs(error.retryAfter, clock()) ?? 0));
	};
	const accountStatus = (cache: ProxyCache, entry?: AccountCache): QuotaStatus => {
		const managementBlocked = cache.managementUntil > clock();
		const error = managementBlocked ? cache.managementError?.message : entry?.error;
		return {
			checkedAt: entry?.checkedAt, error,
			nextFetchAt: Math.max(entry?.retryAt ?? 0, cache.managementUntil) || undefined,
			rateLimited: managementBlocked || entry?.rateLimited,
			retryAt: error ? Math.max(entry?.retryAt ?? 0, managementBlocked ? cache.managementUntil : 0) : undefined,
			stale: Boolean(entry?.windows && (error || clock() - (entry.checkedAt ?? 0) >= QUOTA_TTL_MS)),
		};
	};

	async function routing(base: string, key: string, signal?: AbortSignal, refresh = false): Promise<CredentialModels[]> {
		signal?.throwIfAborted();
		base = base.replace(/\/$/, "");
		const cache = cacheFor(base, key);
		if (cache.routeFlight && !cache.routeFlight.controller.signal.aborted) return joinFlight(cache.routeFlight, signal);
		if (cache.managementUntil > clock()) {
			if (cache.routes) return cache.routes;
			throw cache.managementError;
		}
		if (cache.routes && ((!refresh && clock() - cache.routesAt < QUOTA_TTL_MS) || clock() - cache.routeAttemptAt < ROUTING_THROTTLE_MS)) return cache.routes;
		if (cache.routeRetryAt > clock()) {
			if (cache.routes) return cache.routes;
			throw cache.routeError;
		}
		cache.routeAttemptAt = clock();
		const controller = new AbortController();
		const flight: Flight<CredentialModels[]> = { controller, users: 0, promise: Promise.resolve().then(async () => {
			try {
				const creds = await listCredentials(base, key, controller.signal);
				controller.signal.throwIfAborted();
				const routes = await discoverCredentialModels(base, key, creds, controller.signal);
				controller.signal.throwIfAborted();
				cache.routes = routes;
				cache.routesAt = clock();
				cache.routeRetryAt = 0;
				cache.routeError = undefined;
				return routes;
			} catch (err) {
				if (!controller.signal.aborted) {
					cache.routeError = err as Error;
					cache.routeRetryAt = clock() + ROUTING_THROTTLE_MS;
					managementFailure(cache, err as QuotaHttpError);
				}
				throw err;
			}
		}).finally(() => { if (cache.routeFlight === flight) cache.routeFlight = undefined; }) };
		cache.routeFlight = flight;
		return joinFlight(flight, signal);
	}

	function snapshot(base: string, key: string, routes: CredentialModels[]): QuotaSnapshot {
		const cache = cacheFor(base, key);
		// Discovery may complete while a long collection is still fetching account quotas.
		// Never publish an older credential list over a newer registry result.
		routes = cache.routes ?? routes;
		const windows = new Map<string, Win[]>();
		const statuses = new Map<string, QuotaStatus>();
		for (const { credential } of routes) {
			const index = credential.auth_index as string;
			const entry = cache.accounts.get(index);
			if (entry?.windows) windows.set(index, entry.windows);
			statuses.set(index, accountStatus(cache, entry));
		}
		return { base: base.replace(/\/$/, ""), routes, windows, statuses };
	}

	async function quota(base: string, key: string, cred: AuthFile, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const cache = cacheFor(base, key);
		const index = cred.auth_index as string;
		if (cache.routes && !cache.routes.some((r) => r.credential.auth_index === index && !r.credential.disabled)) return;
		let entry = cache.accounts.get(index);
		if (!entry) { entry = { retryAt: 0, failures: 0 }; cache.accounts.set(index, entry); }
		if (entry.flight && !entry.flight.controller.signal.aborted) return joinFlight(entry.flight, signal);
		if (cache.managementUntil > clock() || entry.retryAt > clock()) return;
		// Every admitted attempt, including one interrupted after sending, has a minimum spacing.
		entry.retryAt = clock() + QUOTA_TTL_MS;
		const controller = new AbortController();
		const account = entry;
		const flight: Flight<void> = { controller, users: 0, promise: Promise.resolve().then(async () => {
			try {
				controller.signal.throwIfAborted();
				const wins = await ADAPTERS[providerKey(cred)].fetch(base, key, cred, controller.signal);
				controller.signal.throwIfAborted();
				account.windows = wins;
				account.checkedAt = clock();
				// Keep admission-based spacing; completion latency must not add another TTL.
				account.failures = 0;
				account.error = undefined;
				account.rateLimited = false;
				if (cache.managementUntil <= clock()) cache.managementFailures = 0;
			} catch (err) {
				if (controller.signal.aborted) {
					account.error = "refresh interrupted";
					throw err;
				}
				const error = err as QuotaHttpError;
				account.error = error.message;
				account.rateLimited = error.status === 429;
				if (account.rateLimited) {
					account.failures++;
					account.retryAt = clock() + Math.max(backoff(account.failures), retryAfterMs(error.retryAfter, clock()) ?? 0);
				}
				managementFailure(cache, error);
			}
		}).finally(() => { if (account.flight === flight) account.flight = undefined; }) };
		account.flight = flight;
		return joinFlight(flight, signal);
	}

	async function collect(base: string, key: string, now = clock(), signal?: AbortSignal): Promise<{ blocks: string[]; snapshot: QuotaSnapshot }> {
		base = base.replace(/\/$/, "");
		const routes = await routing(base, key, signal);
		signal?.throwIfAborted();
		const known = routes.map((r) => r.credential).filter((c) => ADAPTERS[providerKey(c)])
			.sort((a, b) => (providerKey(a) === "claude" ? 0 : 1) - (providerKey(b) === "claude" ? 0 : 1));
		if (!known.length) throw new Error("NO_CRED");
		for (const cred of known) {
			signal?.throwIfAborted();
			await quota(base, key, cred, signal);
		}
		signal?.throwIfAborted();
		const result = snapshot(base, key, routes);
		const blocks: string[] = [];
		for (const cred of known) {
			const index = cred.auth_index as string;
			const pk = providerKey(cred);
			const status = result.statuses?.get(index);
			const wins = result.windows.get(index);
			const heading = `● ${cred.email || cred.label || cred.name} [${pk}]${ADAPTERS[pk].verified ? "" : " (unverified)"}`;
			blocks.push(heading + (status?.stale ? " (cached, stale)" : ""));
			if (wins) blocks.push(...renderWindows(wins, now));
			if (status?.error) blocks.push(`  failed: ${status.error}${status.retryAt ? ` · ${formatReset(new Date(status.retryAt).toISOString(), now).replace("resets", "retry")}` : ""}`);
			else if (!wins) blocks.push("  (quota refresh pending)");
		}
		return { blocks, snapshot: result };
	}
	return { routing, snapshot, collect };
}

// Survive extension reloads/duplicate loads in the same process. No secrets are persisted to disk.
const cacheSymbol = Symbol.for("pi-cliproxyapi-quota.cache.v1");
const processCache = globalThis as typeof globalThis & { [key: symbol]: Map<string, ProxyCache> | undefined };
const defaultQuotaClient = createQuotaClient({}, processCache[cacheSymbol] ??= new Map());

export async function collectQuota(
	base: string, key: string, now = Date.now(), selectedAuthIndex?: string | null,
	theme?: FooterTheme, model?: ModelHint, options: { signal?: AbortSignal; client?: QuotaClient } = {},
): Promise<{ blocks: string[]; footer: string; snapshot: QuotaSnapshot }> {
	const result = await (options.client ?? defaultQuotaClient).collect(base, key, now, options.signal);
	return { ...result, footer: quotaFooter(result.snapshot, model, selectedAuthIndex, now, theme) };
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

function formatAmount(val: number): string {
	if (Math.abs(val - Math.round(val)) < 0.000001) return String(Math.round(val));
	return String(Number(val.toFixed(2)));
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
		const detailStr =
			w.used !== undefined && w.used !== null && w.limit !== undefined && w.limit !== null
				? ` (${formatAmount(w.used)}/${formatAmount(w.limit)}${w.unit ? ` ${w.unit}` : ""} · ${formatAmount(Math.max(0, w.limit - w.used))} left)`
				: "";
		return `  ${w.label.padEnd(22)} ${bar(used)} ${used.toFixed(0)}% used · ${remain.toFixed(0)}% left${detailStr} · ${resetStr}${tagStr}`;
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

export default function (pi: ExtensionAPI, client: QuotaClient = defaultQuotaClient): void {
	const QUOTA_KEY = "cliproxy-quota";
	let footerTimer: ReturnType<typeof setTimeout> | undefined;
	let timerGeneration = 0;
	let lifecycle = new AbortController();
	let background = new AbortController();
	let connectionLifetime = new AbortController();
	let active = false;
	let activeCtx: ExtensionContext | undefined;
	let connectionScope: string | undefined;
	let snapshotScope: string | undefined;
	let routingRevision = 0;
	let snapshot: QuotaSnapshot | undefined;
	let selectedAuthIndex: string | null = null;
	let requestRun: { revision: number; modelKey: string; scope: string } | undefined;
	let pendingRequest: typeof requestRun;

	const modelKey = (model: ProxyModel | undefined) => JSON.stringify([model?.provider, model?.id, model?.baseUrl]);
	const currentScope = () => scopeId(resolveBaseUrl(), resolveManagementKey() ?? "");

	function connection(): { base: string; key: string; scope: string } {
		const base = resolveBaseUrl().replace(/\/$/, "");
		const key = resolveManagementKey();
		if (!key) throw new Error("NO_KEY");
		const scope = scopeId(base, key);
		if (connectionScope !== scope) {
			background.abort();
			connectionLifetime.abort();
			background = new AbortController();
			connectionLifetime = new AbortController();
			connectionScope = scope;
			snapshot = undefined;
			selectedAuthIndex = null;
		}
		return { base, key, scope };
	}

	function updateFooter(ctx: ExtensionContext): void {
		if (!isPrimaryUiSession(ctx)) return;
		if (!isProxyModel(ctx.model, resolveBaseUrl())) {
			ctx.ui.setStatus(QUOTA_KEY, undefined);
			return;
		}
		const footer = snapshot && snapshotScope === currentScope()
			? quotaFooter(snapshot, ctx.model, selectedAuthIndex, Date.now(), ctx.ui.theme)
			: "Quota routing unavailable";
		ctx.ui.setStatus(QUOTA_KEY, ctx.ui.theme.fg("dim", footer));
	}

	async function refreshRouting(ctx: ExtensionContext, refresh = false): Promise<void> {
		if (!active || !isPrimaryUiSession(ctx) || !isProxyModel(ctx.model, resolveBaseUrl())) return;
		const session = lifecycle;
		let signal: AbortSignal | undefined;
		try {
			const { base, key, scope } = connection();
			signal = AbortSignal.any([session.signal, background.signal, connectionLifetime.signal]);
			// Missing auth traces only refresh the LOCAL registry, coalesced/throttled by the client.
			const routes = await client.routing(base, key, signal, refresh);
			signal.throwIfAborted();
			if (session !== lifecycle || scope !== currentScope()) return;
			snapshot = client.snapshot(base, key, routes);
			snapshotScope = scope;
			updateFooter(activeCtx ?? ctx);
		} catch {
			if (!signal?.aborted && session === lifecycle && active) updateFooter(activeCtx ?? ctx);
		}
	}

	async function runQuota(ctx: ExtensionContext, silent = false): Promise<void> {
		if (!active || (silent && !isProxyModel(ctx.model, resolveBaseUrl()))) return;
		const session = lifecycle;
		let signal: AbortSignal | undefined;
		if (!silent) ctx.ui.notify("Fetching quota (up to 5-minute cache)…", "info");
		try {
			const { base, key, scope } = connection();
			signal = AbortSignal.any(silent ? [session.signal, background.signal, connectionLifetime.signal] : [session.signal, connectionLifetime.signal]);
			const result = await client.collect(base, key, Date.now(), signal);
			signal.throwIfAborted();
			if (session !== lifecycle || scope !== currentScope()) return;
			snapshot = result.snapshot;
			snapshotScope = scope;
			if (!silent) ctx.ui.notify(`Subscription quota\n${result.blocks.join("\n")}`, "info");
			// Quota is account-scoped, so an ongoing refresh safely renders the newly selected model.
			updateFooter(activeCtx ?? ctx);
		} catch (err) {
			if (signal?.aborted || session !== lifecycle || !active) return;
			const msg = (err as Error).message;
			if (msg === "NO_CRED") {
				snapshot = undefined;
				selectedAuthIndex = null;
				updateFooter(activeCtx ?? ctx);
			} else if (!snapshot) updateFooter(activeCtx ?? ctx);
			if (silent) return;
			if (msg === "NO_KEY") {
				ctx.ui.notify('Management key not found. Set CLIPROXYAPI_MANAGEMENT_KEY or configure ~/.pi/agent/cliproxyapi-quota.json / EasyCLIProxyAPI.', "error");
			} else if (msg === "NO_CRED") {
				ctx.ui.notify("No usable OAuth credential found (claude / codex / antigravity / gemini / kimi / xai / kiro).", "warning");
			} else ctx.ui.notify(`Failed to fetch quota: ${msg}`, "error");
		}
	}

	function clearTimer(): void {
		if (footerTimer !== undefined) clearTimeout(footerTimer);
		footerTimer = undefined;
		timerGeneration++;
	}

	function nextPollDelay(): number {
		const now = Date.now();
		const future = [...(snapshot?.statuses?.values() ?? [])]
			.flatMap((s) => s.nextFetchAt && s.nextFetchAt > now ? [s.nextFetchAt - now] : []);
		return Math.max(1000, Math.min(QUOTA_TTL_MS, ...future));
	}

	function schedule(ctx: ExtensionContext, initialQuota: boolean): void {
		clearTimer();
		activeCtx = ctx;
		updateFooter(ctx);
		if (!isPrimaryUiSession(ctx) || !isProxyModel(ctx.model, resolveBaseUrl())) {
			background.abort();
			return;
		}
		if (background.signal.aborted) background = new AbortController();
		const generation = timerGeneration;
		const arm = () => {
			if (!active || generation !== timerGeneration || background.signal.aborted) return;
			footerTimer = setTimeout(() => void poll(), nextPollDelay());
			footerTimer.unref();
		};
		const poll = async () => {
			if (activeCtx) await runQuota(activeCtx, true);
			arm();
		};
		if (initialQuota) void poll();
		else {
			void refreshRouting(ctx); // Model switches never fetch upstream quota.
			arm();
		}
	}

	function resetSession(): void {
		clearTimer();
		lifecycle.abort();
		background.abort();
		connectionLifetime.abort();
		lifecycle = new AbortController();
		background = new AbortController();
		connectionLifetime = new AbortController();
		routingRevision++;
		requestRun = undefined;
		pendingRequest = undefined;
		selectedAuthIndex = null;
		snapshot = undefined;
		snapshotScope = undefined;
	}

	pi.on("model_select", (_e, ctx) => {
		if (!active) return;
		routingRevision++;
		selectedAuthIndex = null;
		pendingRequest = undefined;
		schedule(ctx, false);
	});
	pi.on("session_start", (_e, ctx) => {
		resetSession();
		active = true;
		schedule(ctx, true);
	});
	pi.on("session_shutdown", (_e, ctx) => {
		active = false;
		resetSession();
		activeCtx = undefined;
		if (isPrimaryUiSession(ctx)) ctx.ui.setStatus(QUOTA_KEY, undefined);
	});

	pi.on("before_agent_start", (_e, ctx) => {
		requestRun = { revision: routingRevision, modelKey: modelKey(ctx.model), scope: currentScope() };
	});
	pi.on("agent_settled", () => {
		requestRun = undefined;
		pendingRequest = undefined;
	});
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		const outgoingModel = payload && typeof payload === "object" && "model" in payload && typeof payload.model === "string"
			? payload.model : undefined;
		pendingRequest = active && requestRun?.revision === routingRevision && requestRun.modelKey === modelKey(ctx.model) &&
			requestRun.scope === currentScope() && (!outgoingModel || outgoingModel === ctx.model?.id) && isProxyModel(ctx.model, resolveBaseUrl())
			? { ...requestRun } : undefined;
		// Ignore unbound idle warming and requests prepared by a model-switched run.
		if (!pendingRequest) return;
		selectedAuthIndex = null;
		updateFooter(ctx);
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (!active || !pendingRequest || pendingRequest.revision !== routingRevision || pendingRequest.modelKey !== modelKey(ctx.model) ||
			pendingRequest.scope !== currentScope() || !isProxyModel(ctx.model, resolveBaseUrl())) return;
		selectedAuthIndex = event.status >= 200 && event.status < 300 ? authIndexFromHeaders(event.headers) : null;
		updateFooter(ctx);
		if (selectedAuthIndex && !snapshot?.routes.some((r) => r.credential.auth_index === selectedAuthIndex)) void refreshRouting(ctx, true);
	});

	pi.registerShortcut("ctrl+shift+q", {
		description: "Show subscription quota (all OAuth providers)", handler: (ctx) => runQuota(ctx),
	});
	pi.registerCommand("quota", {
		description: "Show subscription quota for all OAuth providers (via CLIProxyAPI)",
		handler: async (_args, ctx) => runQuota(ctx),
	});
}
