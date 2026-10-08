// Live smoke test of the quota data path + pure renderers.
// Run: node test-quota.mjs
import {
	resolveBaseUrl,
	resolveManagementKey,
	collectQuota,
	renderWindows,
	summaryFromWins,
	formatReset,
	parseCodexUsage,
	parseQuotaSummary,
	parseKiroUsage,
	kiroWindowLabel,
	isKiroModel,
	selectBestGroup,
	providerFromModel,
} from "./index.ts";

// formatReset unit checks
const now = Date.parse("2026-08-19T09:00:00Z");
console.assert(formatReset(null, now) === "—", "null reset");
console.assert(formatReset("2026-08-19T08:00:00Z", now) === "resets now", "past reset");
console.assert(/^resets in /.test(formatReset("2026-08-19T11:50:00Z", now)), "future reset");

// renderWindows / summaryFromWins unit checks
const wins = [
	{ label: "5-hour (session)", remainingPct: 64, resetIso: "2026-08-19T11:50:00Z" },
	{ label: "7-day (weekly)", remainingPct: 95, resetIso: "2026-08-25T03:00:00Z" },
];
const expectedFooter = "Quota 5h ━━━━── 64% ↻2h50m · 7d ━━━━━━ 95% ↻5d18h";
console.assert(summaryFromWins(wins, now) === expectedFooter, "plain footer");
console.assert(summaryFromWins([...wins].reverse(), now) === expectedFooter, "5h then weekly footer order");
console.assert(renderWindows(wins, now)[0].includes("36% used · 64% left"), "render used/left");

const mockTheme = { fg: (color, text) => `<${color}>${text}</${color}>` };
const themedHealthy = summaryFromWins(wins, now, mockTheme);
console.assert(themedHealthy.includes("<success>━━━━</success><dim>──</dim> <success>64%</success>"), "healthy footer tone");
const themedWarning = summaryFromWins([{ label: "5h", remainingPct: 30, resetIso: null }], now, mockTheme);
console.assert(themedWarning.includes("<warning>━━</warning><dim>────</dim> <warning>30%</warning>"), "warning footer tone");
const themedCritical = summaryFromWins([{ label: "5h", remainingPct: 10, resetIso: null }], now, mockTheme);
console.assert(themedCritical.includes("<error>━</error><dim>─────</dim> <error>10%</error>"), "critical footer tone");
console.assert(summaryFromWins([{ label: "unknown", remainingPct: null, resetIso: null }], now) === "Quota n/a", "null footer window");
console.assert(
	summaryFromWins([...wins, { label: "1h", remainingPct: 50, resetIso: null }], now).includes("1h") === false,
	"footer only shows two windows",
);
console.assert(summaryFromWins([{ label: "5h", remainingPct: 125, resetIso: "2026-08-19T14:00:00Z" }], now) === "Quota 5h ━━━━━━ 100%", "clamped footer quota");
console.assert(providerFromModel({ provider: "openai", id: "gpt-5" }) === "codex", "provider model detection");
console.assert(providerFromModel({ provider: "kiro", id: "auto" }) === "kiro", "provider kiro auto detection");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "kiro/claude-opus-5.5" }) === "kiro", "provider kiro model prefix detection");
console.assert(providerFromModel({ provider: "kiro", id: "claude-sonnet-4-6" }) === "kiro", "kiro provider overrides claude text");
console.assert(isKiroModel({ provider: "cliproxyapi", id: "claude-opus-5.5" }), "isKiroModel claude-opus-5.5");
console.assert(isKiroModel("claude-opus-5.5"), "isKiroModel string id");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "claude-opus-5.5" }) === "kiro", "providerFromModel claude-opus-5.5 mapped to kiro");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "claude-sonnet-5.5" }) === "kiro", "providerFromModel claude-sonnet-5.5 mapped to kiro");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "gpt-5.6-terra" }) === "kiro", "providerFromModel gpt-5.6-terra mapped to kiro");
console.assert(providerFromModel({ provider: "cliproxyapi", id: "claude-sonnet-4.6" }, ["kiro"]) === "kiro", "providerFromModel claude fallback to kiro when only kiro available");

// kiroWindowLabel unit checks
console.assert(kiroWindowLabel("Credits", "Plan") === "monthly credits", "kiro default plan label");
console.assert(kiroWindowLabel("Credits", "Free trial") === "credits · free trial", "kiro free trial label");
console.assert(kiroWindowLabel("Account Pool", "Monthly") === "Account Pool · Monthly", "kiro custom group label");

// parseKiroUsage unit checks:
// 1. Live observed shape: subscription, summary used_0/limit_0, groups with Credits/Plan
const kiroLive = parseKiroUsage(JSON.stringify({
	subscription: { plan: "KIRO PRO+", tierId: "Q_DEVELOPER_STANDALONE_PRO_PLUS" },
	summary: [
		{ key: "used_0", label: "Credits used", value: 27.1, unit: "invocations", format: "number" },
		{ key: "limit_0", label: "Credits limit", value: 2000, unit: "invocations", format: "number" },
	],
	groups: [
		{
			displayName: "Credits",
			buckets: [
				{ window: "Plan", remainingFraction: 0.98645, resetTime: "2026-11-01T00:00:00Z", description: "27.1 / 2000" },
			],
		},
	],
}));
console.assert(kiroLive.length === 1, "kiro live length");
console.assert(kiroLive[0].label === "monthly credits", "kiro live label");
console.assert(Math.abs((kiroLive[0].remainingPct ?? 0) - 98.645) < 0.001, "kiro live remainingPct");
console.assert(kiroLive[0].used === 27.1 && kiroLive[0].limit === 2000 && kiroLive[0].unit === "invocations", "kiro live metrics");
console.assert(kiroLive[0].resetIso === "2026-11-01T00:00:00Z", "kiro live resetIso");

// renderWindows with Kiro metrics: should display percentage, used/limit, remaining absolute, and reset countdown
const renderedKiro = renderWindows(kiroLive, now)[0];
console.assert(renderedKiro.includes("1% used · 99% left (27.1/2000 invocations · 1972.9 left)"), "kiro render detail formatting");
console.assert(summaryFromWins(kiroLive, now).includes("Quota monthly ━━━━━━ 99%"), "kiro footer compact percentage");

// 2. Exhausted quota (0% remaining fraction)
const kiroExhausted = parseKiroUsage(JSON.stringify({
	summary: [
		{ key: "used_0", value: 50, unit: "invocations" },
		{ key: "limit_0", value: 50, unit: "invocations" },
	],
	groups: [
		{
			displayName: "Credits",
			buckets: [
				{ window: "Plan", remainingFraction: 0, resetTime: "2026-09-01T00:00:00Z", description: "50 / 50" },
			],
		},
	],
}));
console.assert(kiroExhausted.length === 1 && kiroExhausted[0].remainingPct === 0, "kiro exhausted remainingPct 0 preserved");
console.assert(renderWindows(kiroExhausted, now)[0].includes("100% used · 0% left (50/50 invocations · 0 left)"), "kiro exhausted render");

// 3. Fallback when summary array is missing but bucket description has "used / limit unit"
const kiroFallback = parseKiroUsage(JSON.stringify({
	groups: [
		{
			displayName: "Credits",
			buckets: [
				{ window: "Plan", description: "15 / 100 requests", resetTime: "2026-09-01T00:00:00Z" },
			],
		},
	],
}));
console.assert(kiroFallback.length === 1, "kiro fallback parsed");
console.assert(kiroFallback[0].used === 15 && kiroFallback[0].limit === 100 && kiroFallback[0].unit === "requests", "kiro description parsed");
console.assert(kiroFallback[0].remainingPct === 85, "kiro fallback calculated remainingPct");

// 4. Multiple buckets (Plan + Free trial)
const kiroMulti = parseKiroUsage(JSON.stringify({
	summary: [
		{ key: "used_0", value: 10, unit: "credits" },
		{ key: "limit_0", value: 100, unit: "credits" },
		{ key: "used_1", value: 5, unit: "credits" },
		{ key: "limit_1", value: 20, unit: "credits" },
	],
	groups: [
		{
			displayName: "Credits",
			buckets: [
				{ window: "Plan", remainingFraction: 0.9, resetTime: "2026-11-01T00:00:00Z" },
				{ window: "Free trial", remainingFraction: 0.75, resetTime: "2026-09-01T00:00:00Z" },
			],
		},
	],
}));
console.assert(kiroMulti.length === 2, "kiro multi length");
console.assert(kiroMulti[0].label === "monthly credits" && kiroMulti[1].label === "credits · free trial", "kiro multi labels");

// 100% remaining should NOT display a countdown (avoids sliding resetTime illusion like ↻4h59m)
const fullWins = [
	{ label: "5-hour (session)", remainingPct: 100, resetIso: "2026-08-19T14:00:00Z" },
];
console.assert(summaryFromWins(fullWins, now) === "Quota 5h ━━━━━━ 100%", "footer full quota");
console.assert(renderWindows(fullWins, now)[0].includes("100% left · —"), "render full reset");
// rounding hole: 99.96% displays as 100% and must also hide the (sliding) countdown
const nearFull = [
	{ label: "5-hour (session)", remainingPct: 99.96, resetIso: "2026-08-19T14:00:00Z" },
];
console.assert(summaryFromWins(nearFull, now) === "Quota 5h ━━━━━━ 100%", "footer near-full quota");

// tag unit checks (e.g. limit reached)
const taggedWins = [
	{ label: "30d", remainingPct: 0, resetIso: "2026-08-26T09:00:00Z", tag: "limit reached" },
];
console.assert(summaryFromWins(taggedWins, now) === "Quota 30d ────── 0% ↻7d0h (limit reached)", "footer tagged");
console.assert(renderWindows(taggedWins, now)[0].includes("100% used · 0% left · resets in 7d 0h · limit reached"), "render tagged");

// Antigravity multi-group unit checks
const agJson = JSON.stringify({
	groups: [
		{
			displayName: "Gemini Models",
			buckets: [
				{ window: "weekly", resetTime: "2026-08-25T03:00:00Z", remainingFraction: 0.65 },
				{ window: "5h", resetTime: "2026-08-19T13:30:00Z", remainingFraction: 0.82 },
			],
		},
		{
			displayName: "Claude and GPT models",
			buckets: [
				{ window: "weekly", resetTime: "2026-08-25T03:00:00Z", remainingFraction: 1 },
				{ window: "5h", resetTime: "2026-08-19T13:30:00Z", remainingFraction: 1 },
			],
		},
	],
});
const agWins = parseQuotaSummary(agJson);
console.assert(agWins.length === 4, "antigravity parse length");
console.assert(agWins[0].group === "Gemini Models", "antigravity group parsed");
console.assert(selectBestGroup(agWins) === "Gemini Models", "antigravity defaults to used group");
console.assert(selectBestGroup(agWins, "gemini-3.8-flash-high") === "Gemini Models", "antigravity model hint gemini");
console.assert(selectBestGroup(agWins, "claude-sonnet-4-6") === "Claude and GPT models", "antigravity model hint claude");
console.assert(selectBestGroup(agWins, "gpt-5.5") === "Claude and GPT models", "antigravity model hint gpt");

// Multi-group footer: must show 5h + 7d for the chosen group (never two 5h windows!)
const agFooterDefault = summaryFromWins(agWins, now);
console.assert(agFooterDefault.includes("5h") && agFooterDefault.includes("7d"), "ag footer shows 5h and 7d");
console.assert(!agFooterDefault.includes("100%"), "ag footer chooses used group");
console.assert(
	(agFooterDefault.match(/5h/g) || []).length === 1,
	"ag footer never duplicates 5h window",
);

const agFooterClaude = summaryFromWins(agWins, now, undefined, "claude-sonnet-4-6");
console.assert(agFooterClaude === "Quota 5h ━━━━━━ 100% · 7d ━━━━━━ 100%", "ag claude group footer");

// Deduplication check: even if arbitrary duplicate 5h windows exist without group, 5h is not duplicated
const dupWins = [
	{ label: "5-hour (A)", remainingPct: 80, resetIso: "2026-08-19T11:50:00Z" },
	{ label: "5-hour (B)", remainingPct: 100, resetIso: "2026-08-19T11:50:00Z" },
	{ label: "7-day (C)", remainingPct: 90, resetIso: "2026-08-25T03:00:00Z" },
];
const dupFooter = summaryFromWins(dupWins, now);
console.assert((dupFooter.match(/5h/g) || []).length === 1, "dupWins never duplicates 5h");
console.assert(dupFooter.includes("7d"), "dupWins includes 7d");

// parseCodexUsage unit checks:
// 1. Current shape (Plus/Team): rate_limit, primary_window/secondary_window, reset_after_seconds
const codexPlus = parseCodexUsage(JSON.stringify({
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 3981 },
		secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_after_seconds: 398155 },
	},
}), now);
console.assert(codexPlus.length === 2, "codex plus length");
console.assert(codexPlus[0].label === "5h" && codexPlus[0].remainingPct === 99, "codex plus 5h");
console.assert(codexPlus[1].label === "weekly" && codexPlus[1].remainingPct === 84, "codex plus weekly");
console.assert(codexPlus[0].tag === undefined, "codex plus tag");

// 2. Exhausted Free shape: allowed=false, limit_reached=true, secondary_window=null
const codexFree = parseCodexUsage(JSON.stringify({
	plan_type: "free",
	rate_limit: {
		allowed: false,
		limit_reached: true,
		primary_window: { used_percent: 100, limit_window_seconds: 2592000, reset_after_seconds: 1244239 },
		secondary_window: null,
	},
}), now);
console.assert(codexFree.length === 1, "codex free length");
console.assert(codexFree[0].label === "30d" && codexFree[0].remainingPct === 0, "codex free 30d");
console.assert(codexFree[0].tag === "limit reached", "codex free tag");

// 3. Legacy shape: rate_limits, primary, secondary, resets_in_seconds
const codexLegacy = parseCodexUsage(JSON.stringify({
	rate_limits: {
		primary: { used_percent: 10, resets_in_seconds: 1800 },
		secondary: { used_percent: 20, resets_in_seconds: 3600 },
	},
}), now);
console.assert(codexLegacy.length === 2, "codex legacy length");
console.assert(codexLegacy[0].label === "5h" && codexLegacy[0].remainingPct === 90, "codex legacy 5h");
console.assert(codexLegacy[1].label === "weekly" && codexLegacy[1].remainingPct === 80, "codex legacy weekly");

const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/auth-files")) {
			return Response.json({
				files: [
					{ id: "claude-1", name: "Claude", provider: "claude", auth_index: "claude-1", email: "user@example.com" },
					{ id: "kiro-1", name: "kiro-idc.json", provider: "kiro", auth_index: "kiro-1", label: "Kiro Account" },
				],
			});
		}
		if (url.endsWith("/api-call")) {
			return Response.json({
				status_code: 200,
				body: JSON.stringify({
					five_hour: { utilization: 36, resets_at: "2026-08-19T11:50:00Z" },
					seven_day: { utilization: 5, resets_at: "2026-08-25T03:00:00Z" },
				}),
			});
		}
		if (url.endsWith("/quota/fetch")) {
			return Response.json({
				subscription: { plan: "KIRO PRO+" },
				summary: [
					{ key: "used_0", value: 27.1, unit: "invocations" },
					{ key: "limit_0", value: 2000, unit: "invocations" },
				],
				groups: [
					{
						displayName: "Credits",
						buckets: [
							{ window: "Plan", remainingFraction: 0.98645, resetTime: "2026-11-01T00:00:00Z" },
						],
					},
				],
			});
		}
		throw new Error(`Unexpected mocked request: ${url}`);
	};
	const mocked = await collectQuota("http://mock", "test-key", now, "codex");
	console.assert(mocked.footer.startsWith("Quota[claude] 5h ━━━━── 64%"), "provider fallback footer");
	console.assert(mocked.blocks[0] === "● user@example.com [claude]", "mocked credential rendering");
	console.assert(mocked.blocks[3] === "● Kiro Account [kiro]", "mocked kiro credential rendering");
	console.assert(mocked.blocks[4].includes("monthly credits"), "mocked kiro window rendering");
	console.assert(mocked.blocks[4].includes("27.1/2000 invocations"), "mocked kiro detail rendering");

	const mockedKiro = await collectQuota("http://mock", "test-key", now, "kiro");
	console.assert(mockedKiro.footer.startsWith("Quota[kiro] monthly ━━━━━━ 99%"), "kiro model selection footer");

	const themedMocked = await collectQuota("http://mock", "test-key", now, "codex", mockTheme);
	console.assert(themedMocked.footer.startsWith("Quota[claude] <dim>5h </dim>"), "theme forwarded through quota collection");
} finally {
	globalThis.fetch = originalFetch;
}

console.log("units OK:", summaryFromWins(wins, now));
if (process.argv.includes("--offline")) {
	console.log("offline OK");
	process.exit(0);
}

const base = resolveBaseUrl();
const key = resolveManagementKey();
console.log("baseUrl:", base);
console.log("managementKey:", key ? key.slice(0, 6) + "…(" + key.length + " chars)" : "NONE");
if (!key) process.exit(1);

const { blocks, footer } = await collectQuota(base, key);
console.log("\n" + blocks.join("\n"));
console.log("\nfooter:", footer);
console.log("\nOK");
