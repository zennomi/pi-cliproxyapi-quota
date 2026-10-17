// Offline only: manual reset reads must never claim/consume a reset or contact a live proxy.
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createQuotaClient, parseClaudeManualResets, parseCodexManualResets, renderManualResets, quotaFooter } from "./index.ts";

const BASE = "http://mock-manual-resets";
const C = "1111111111111111";
const O = "2222222222222222";
const SECOND = "3333333333333333";
const TTL = 300_000;
const NOW = Date.parse("2026-10-17T05:00:00Z");
const dates = ["2026-10-22T20:31:00Z", "2026-10-29T19:00:00Z", "2026-11-06T23:26:00Z"];
const credit = (expires_at, extra = {}) => ({ reset_type: "codex_rate_limits", status: "available", expires_at, ...extra });
const grant = (ends_at, left = 1, total = left) => ({ ends_at, resets_left: left, resets_total: total });
const claudeBody = { cedar_ember: { eligible: true, grants: dates.map((date) => grant(date)) } };
const codexBody = { available_count: 3, credits: dates.map((date) => credit(date)) };
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};

function setup(t, files) {
	let now = NOW;
	const h = {
		client: createQuotaClient({ now: () => now, random: () => 0 }),
		files: files ?? [
			{ id: "c", name: "claude.json", provider: "claude", auth_index: C },
			{ id: "o", name: "codex.json", provider: "codex", auth_index: O, account_id: "offline-account" },
		],
		requests: [], resetStatus: 200, retryAfter: "600", bodies: new Map([[C, claudeBody], [O, codexBody]]),
		usageGate: undefined, resetGate: undefined, management429: false,
		get now() { return now; },
		advance(ms) { now += ms; },
		count(auth, resets = true) { return h.requests.filter((r) => r.authIndex === auth && r.resets === resets).length; },
		collect(signal) { return h.client.collect(BASE, "offline-key", now, signal); },
	};
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const url = new URL(String(input));
		assert.equal(url.origin, BASE, "never contact a live proxy");
		if (url.pathname.endsWith("/auth-files")) return Response.json({ files: h.files });
		if (url.pathname.endsWith("/auth-files/models")) return Response.json({ models: [{ id: "shared-model" }] });
		assert.ok(url.pathname.endsWith("/api-call"));
		const req = JSON.parse(options.body);
		assert.equal(req.method, "GET", "manual resets must be strictly read-only");
		assert.ok(!/consume|reset_rate_limits/.test(req.url));
		const resets = req.url.includes("cedar_ember=") || req.url.endsWith("/rate-limit-reset-credits");
		h.requests.push({ ...req, resets });
		if (resets) {
			h.resetSignal = options.signal;
			if (h.resetGate) await h.resetGate;
			if (h.management429) return Response.json({}, { status: 429, headers: { "Retry-After": h.retryAfter } });
			return Response.json({ status_code: h.resetStatus, header: { "Retry-After": [h.retryAfter] }, body: JSON.stringify(h.bodies.get(req.authIndex) ?? claudeBody) });
		}
		if (h.usageGate) await h.usageGate;
		return Response.json({ status_code: 200, body: JSON.stringify({
			five_hour: { utilization: 20 }, rate_limit: { primary_window: { used_percent: 30 } },
		}) });
	});
	return h;
}

test("Codex parses available reset credits only, snake/camel fields and count fallback", () => {
	const parsed = parseCodexManualResets(JSON.stringify({ credits: [
		credit(dates[0]),
		{ resetType: "codex_rate_limits", status: "available", expiresAt: dates[1] },
		credit(dates[2], { status: "consumed" }),
		credit(dates[2], { reset_type: "other" }),
		null,
	] }));
	assert.deepEqual(parsed, { availableCount: 2, expiries: dates.slice(0, 2).map((expiresAt) => ({ expiresAt, count: 1 })) });
	assert.equal(parseCodexManualResets('{"availableCount":"0","credits":[]}').availableCount, 0);
	assert.equal(parseCodexManualResets('{"available_count":3}').availableCount, 3);
	assert.equal(parseCodexManualResets('{"applicable_available_count":1}').availableCount, null, "applicable is not the total banked count");
	assert.equal(parseCodexManualResets(JSON.stringify({ credits: [credit("bad date")] })).expiries[0].expiresAt, null);
	for (const body of ["{}", "null", "[]", "broken", '{"credits":{}}']) assert.throws(() => parseCodexManualResets(body));
});

test("Claude sums remaining grants, keeps unknown expiry and ignores exhausted grants", () => {
	const parsed = parseClaudeManualResets(JSON.stringify({ cedar_ember: { eligible: true, grants: [
		grant(dates[1], 2, 3), grant(null), grant(dates[0], 0, 1),
	] } }));
	assert.deepEqual(parsed, { availableCount: 3, expiries: [{ expiresAt: dates[1], count: 2 }, { expiresAt: null, count: 1 }] });
	assert.deepEqual(parseClaudeManualResets('{"cedar_ember":{"eligible":false}}'), { availableCount: 0, expiries: [] });
	for (const body of ["{}", "null", '{"cedar_ember":{"grants":[]}}', JSON.stringify({ cedar_ember: { eligible: true, grants: [grant(null, 3, 2)] } })]) {
		assert.throws(() => parseClaudeManualResets(body));
	}
});

test("render matches requested GMT+7 dates/countdowns, sorts without mutating cache", () => {
	const data = { availableCount: 3, expiries: [...dates].reverse().map((expiresAt) => ({ expiresAt, count: 1 })) };
	assert.deepEqual(renderManualResets(data, NOW), [
		"  Manual resets: 3",
		"  Manual reset expiry (GMT+7)",
		"    Reset 1  10/23, 03:31 · in 5 days",
		"    Reset 2  10/30, 02:00 · in 12 days",
		"    Reset 3  11/07, 06:26 · in 20 days",
	]);
	assert.equal(data.expiries[0].expiresAt, dates[2]);
	assert.match(renderManualResets(data, NOW, true)[0], /cached, stale/);
	assert.deepEqual(renderManualResets({ availableCount: 0, expiries: [] }, NOW), ["  Manual resets: 0"]);
	assert.deepEqual(renderManualResets({ availableCount: null, expiries: [] }, NOW), ["  Manual resets: n/a"]);
});

test("render handles grouped grants, unknown expiry, elapsed dates and sub-day countdowns", () => {
	const lines = renderManualResets({ availableCount: 4, expiries: [
		{ expiresAt: null, count: 2 },
		{ expiresAt: new Date(NOW - 1).toISOString(), count: 1 },
		{ expiresAt: new Date(NOW + 90 * 60_000).toISOString(), count: 1 },
	] }, NOW);
	assert.match(lines[2], /expired/);
	assert.match(lines[3], /in 1h 30m/);
	assert.equal(lines[4], "    Reset 3 (2 resets)  Expiry unknown");
});

test("metadata is account-scoped, read-only, single-flight and cached for five minutes", async (t) => {
	const h = setup(t);
	const results = await Promise.all(Array.from({ length: 5 }, () => h.collect()));
	for (const auth of [C, O]) {
		assert.equal(h.count(auth, false), 1);
		assert.equal(h.count(auth), 1);
		assert.equal(results[0].snapshot.manualResets.get(auth).availableCount, 3);
	}
	assert.equal(results[0].blocks.filter((line) => line === "  Manual resets: 3").length, 2);
	const claude = h.requests.find((r) => r.authIndex === C && r.resets);
	assert.equal(claude.url, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
	const codex = h.requests.find((r) => r.authIndex === O && r.resets);
	assert.equal(codex.header["OpenAI-Beta"], "codex-1");
	assert.equal(codex.header.Originator, "Codex Desktop");
	assert.equal(codex.header["Chatgpt-Account-Id"], "offline-account");
	assert.equal(quotaFooter(results[0].snapshot, "shared-model", C, NOW).includes("Manual"), false, "footer remains compact");
	h.advance(TTL - 1);
	await h.collect();
	assert.equal(h.count(C), 1);
	h.advance(1);
	await h.collect();
	assert.equal(h.count(C), 2);
	assert.equal(h.count(O), 2);
});

test("multiple Claude credentials never share manual reset data", async (t) => {
	const h = setup(t, [C, SECOND].map((auth_index) => ({ id: auth_index, name: `${auth_index}.json`, provider: "claude", auth_index })));
	h.bodies.set(SECOND, { cedar_ember: { eligible: true, grants: [grant(dates[0])] } });
	const { snapshot } = await h.collect();
	assert.equal(snapshot.manualResets.get(C).availableCount, 3);
	assert.equal(snapshot.manualResets.get(SECOND).availableCount, 1);
});

test("optional metadata failure retains windows and stale resets, then clears on recovery", async (t) => {
	const h = setup(t);
	await h.collect();
	h.advance(TTL);
	h.resetStatus = 403;
	const result = await h.collect();
	assert.equal(result.snapshot.windows.get(C)[0].remainingPct, 80);
	assert.equal(result.snapshot.statuses.get(C).error, undefined, "quota success is not hidden by optional metadata failure");
	assert.match(result.snapshot.statuses.get(C).manualResetsError, /403/);
	assert.equal(result.snapshot.manualResets.get(C).availableCount, 3);
	assert.ok(result.blocks.includes("  Manual resets: 3 (cached, stale)"));
	assert.ok(result.blocks.some((line) => line.includes("Manual resets unavailable: upstream HTTP 403")));
	h.advance(TTL);
	h.resetStatus = 200;
	const recovered = await h.collect();
	assert.equal(recovered.snapshot.statuses.get(C).manualResetsError, undefined);
	assert.ok(recovered.blocks.includes("  Manual resets: 3"));
});

test("malformed metadata is unavailable, never reported as zero resets", async (t) => {
	const h = setup(t);
	h.bodies.set(C, {});
	h.bodies.set(O, {});
	const result = await h.collect();
	assert.equal(result.snapshot.manualResets.size, 0);
	assert.ok(result.blocks.some((line) => line.includes("Invalid Claude manual reset response")));
	assert.ok(result.blocks.some((line) => line.includes("Invalid Codex manual reset response")));
	assert.equal(result.snapshot.windows.size, 2);
});

test("reset HTTP 429 honors Retry-After and exponential backoff without losing quota", async (t) => {
	const h = setup(t);
	await h.collect();
	h.advance(TTL);
	h.resetStatus = 429;
	h.retryAfter = "600";
	const result = await h.collect();
	assert.equal(result.snapshot.statuses.get(C).retryAt, h.now + 600_000);
	assert.equal(result.snapshot.statuses.get(C).rateLimited, true);
	assert.equal(result.snapshot.manualResets.get(C).availableCount, 3);
	assert.equal(result.snapshot.windows.get(C)[0].remainingPct, 80);
	await h.collect();
	assert.equal(h.count(C), 2);
	h.advance(600_000);
	h.retryAfter = "invalid";
	const second = await h.collect();
	assert.equal(second.snapshot.statuses.get(C).retryAt, h.now + 600_000, "success of windows must not reset metadata 429 backoff");
	h.advance(600_000);
	const third = await h.collect();
	assert.equal(third.snapshot.statuses.get(C).retryAt, h.now + 1_200_000);
});

test("management 429 during reset read prevents later accounts and survives repeated collection", async (t) => {
	const h = setup(t);
	h.management429 = true;
	const result = await h.collect();
	assert.equal(h.count(C), 1);
	assert.equal(h.count(O, false), 0);
	assert.equal(result.snapshot.statuses.get(O).rateLimited, true);
	await h.collect();
	assert.equal(h.count(C), 1);
});

test("cancellation after usage prevents the subsequent metadata read", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.usageGate = gate.promise;
	const controller = new AbortController();
	const pending = h.collect(controller.signal);
	await setImmediate();
	const rejected = assert.rejects(pending, { name: "AbortError" });
	controller.abort();
	await rejected;
	gate.resolve();
	await setImmediate();
	assert.equal(h.count(C), 0);
	assert.equal(h.count(O, false), 0);
});

test("one cancelled subscriber cannot abort another subscriber's reset read", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.resetGate = gate.promise;
	const controller = new AbortController();
	const first = h.collect(controller.signal);
	const second = h.collect();
	await setImmediate();
	assert.equal(h.count(C), 1);
	const rejected = assert.rejects(first, { name: "AbortError" });
	controller.abort();
	await rejected;
	assert.equal(h.resetSignal.aborted, false);
	gate.resolve();
	const result = await second;
	assert.equal(result.snapshot.manualResets.get(C).availableCount, 3);
	assert.equal(h.count(C), 1);
});

test("last subscriber cancellation discards late metadata and prevents the next account", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.resetGate = gate.promise;
	const controller = new AbortController();
	const pending = h.collect(controller.signal);
	await setImmediate();
	const rejected = assert.rejects(pending, { name: "AbortError" });
	controller.abort();
	await rejected;
	assert.equal(h.resetSignal.aborted, true);
	gate.resolve();
	await setImmediate();
	const routes = await h.client.routing(BASE, "offline-key");
	assert.equal(h.client.snapshot(BASE, "offline-key", routes).manualResets.size, 0);
	assert.equal(h.count(O, false), 0);
});

test("reload with legacy quota-only cache shows pending resets without bypassing five-minute spacing", async (t) => {
	const h = setup(t);
	const caches = new Map();
	const previous = createQuotaClient({ now: () => h.now, random: () => 0 }, caches);
	await previous.collect(BASE, "offline-key");
	// Reproduce the process-shared cache shape written before manual reset support existed.
	for (const cache of caches.values()) {
		for (const account of cache.accounts.values()) {
			delete account.manualResets;
			delete account.manualResetsError;
		}
	}
	h.client = createQuotaClient({ now: () => h.now, random: () => 0 }, caches);
	const cached = await h.collect();
	assert.equal(cached.blocks.filter((line) => line === "  Manual resets: n/a (pending refresh) · refresh in 5m").length, 2);
	assert.equal(cached.snapshot.windows.size, 2);
	assert.equal(h.count(C), 1, "reload must not trigger an early reset-data request");
	assert.equal(h.count(C, false), 1);
	h.advance(TTL);
	const refreshed = await h.collect();
	assert.equal(refreshed.snapshot.manualResets.get(C).availableCount, 3);
	assert.equal(refreshed.blocks.filter((line) => line === "  Manual resets: 3").length, 2);
});

test("legacy quota-only cache preserves an active 429 cooldown after reload", async (t) => {
	const h = setup(t);
	const caches = new Map();
	const previous = createQuotaClient({ now: () => h.now, random: () => 0 }, caches);
	await previous.collect(BASE, "offline-key");
	for (const cache of caches.values()) {
		for (const account of cache.accounts.values()) {
			delete account.manualResets;
			account.error = "upstream HTTP 429";
			account.rateLimited = true;
			account.retryAt = h.now + 3_600_000;
		}
	}
	h.client = createQuotaClient({ now: () => h.now, random: () => 0 }, caches);
	const cached = await h.collect();
	assert.equal(cached.blocks.filter((line) => line === "  Manual resets: n/a (pending refresh) · refresh in 1h 0m").length, 2);
	assert.equal(h.count(C), 1);
	assert.equal(h.count(O), 1);
});

test("reset data survives same-process client replacement", async (t) => {
	const h = setup(t);
	const caches = new Map();
	const first = createQuotaClient({ now: () => h.now }, caches);
	const second = createQuotaClient({ now: () => h.now }, caches);
	await first.collect(BASE, "offline-key");
	const result = await second.collect(BASE, "offline-key");
	assert.equal(result.snapshot.manualResets.get(C).availableCount, 3);
	assert.equal(h.count(C), 1);
});
