// Live smoke test of the quota data path + pure renderers.
// Run: node test-quota.mjs
import { resolveBaseUrl, resolveManagementKey, collectQuota, renderWindows, summaryFromWins, formatReset, parseCodexUsage } from "./index.ts";

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
console.assert(summaryFromWins(wins, now) === "Quota 5h 64% left ↻2h50m · 7d 95% left ↻5d18h", "footer");
console.assert(renderWindows(wins, now)[0].includes("36% used · 64% left"), "render used/left");

// 100% remaining should NOT display a countdown (avoids sliding resetTime illusion like ↻4h59m)
const fullWins = [
	{ label: "5-hour (session)", remainingPct: 100, resetIso: "2026-08-19T14:00:00Z" },
];
console.assert(summaryFromWins(fullWins, now) === "Quota 5h 100% left", "footer full quota");
console.assert(renderWindows(fullWins, now)[0].includes("100% left · —"), "render full reset");
// rounding hole: 99.96% displays as 100% and must also hide the (sliding) countdown
const nearFull = [
	{ label: "5-hour (session)", remainingPct: 99.96, resetIso: "2026-08-19T14:00:00Z" },
];
console.assert(summaryFromWins(nearFull, now) === "Quota 5h 100% left", "footer near-full quota");

// tag unit checks (e.g. limit reached)
const taggedWins = [
	{ label: "30d", remainingPct: 0, resetIso: "2026-08-26T09:00:00Z", tag: "limit reached" },
];
console.assert(summaryFromWins(taggedWins, now) === "Quota 30d 0% left ↻7d0h (limit reached)", "footer tagged");
console.assert(renderWindows(taggedWins, now)[0].includes("100% used · 0% left · resets in 7d 0h · limit reached"), "render tagged");

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

console.log("units OK:", summaryFromWins(wins, now));

const base = resolveBaseUrl();
const key = resolveManagementKey();
console.log("baseUrl:", base);
console.log("managementKey:", key ? key.slice(0, 6) + "…(" + key.length + " chars)" : "NONE");
if (!key) process.exit(1);

const { blocks, footer } = await collectQuota(base, key);
console.log("\n" + blocks.join("\n"));
console.log("\nfooter:", footer);
console.log("\nOK");
