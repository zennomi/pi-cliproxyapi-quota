// Fully offline admission-control / cancellation tests. Never query a live proxy.
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { collectQuota, createQuotaClient, quotaFooter, retryAfterMs } from "./index.ts";

const TTL = 300_000;
const C = "1111111111111111";
const O = "2222222222222222";
const BASE = "http://mock-rate-limit";
const KEY = "offline-not-a-secret";
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};

function setup(t, two = false) {
	let now = Date.parse("2026-10-08T12:00:00Z");
	const h = {
		client: createQuotaClient({ now: () => now, random: () => 0 }),
		list: 0, models: 0, usage: new Map(), peak: 0, current: 0,
		files: [{ id: "c", name: "claude.json", provider: "claude", auth_index: C }],
		mode: "success", retryAfter: undefined, retryAfterByAuth: new Map(), listMode: "success", quotaGate: undefined, quotaGates: new Map(), listGate: undefined,
		get now() { return now; },
		advance(ms) { now += ms; },
		async collect(signal) { return h.client.collect(BASE, KEY, now, signal); },
	};
	if (two) h.files.push({ id: "o", name: "codex.json", provider: "codex", auth_index: O });
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const url = new URL(String(input));
		assert.ok([BASE, "http://mock-reload-cache", "http://mock-other-proxy"].includes(url.origin), "a live URL must never escape the mock");
		if (url.pathname.endsWith("/auth-files")) {
			h.list++;
			if (h.listGate) await h.listGate;
			if (h.listMode === "429") return Response.json({}, { status: 429, headers: { "Retry-After": h.retryAfter ?? "600" } });
			return Response.json({ files: h.files });
		}
		if (url.pathname.endsWith("/auth-files/models")) {
			h.models++;
			return Response.json({ models: [{ id: "shared" }] });
		}
		assert.ok(url.pathname.endsWith("/api-call"));
		const auth = JSON.parse(options.body).authIndex;
		h.usage.set(auth, (h.usage.get(auth) ?? 0) + 1);
		h.current++;
		h.peak = Math.max(h.peak, h.current);
		h.requestSignal = options.signal;
		if (h.quotaGate && auth === C) await h.quotaGate;
		else if (h.quotaGates.has(auth)) await h.quotaGates.get(auth);
		else await setImmediate();
		h.current--;
		if (h.mode === "outer429") return Response.json({}, { status: 429, headers: { "Retry-After": h.retryAfterByAuth.get(auth) ?? h.retryAfter ?? "3600" } });
		if (h.mode === "429" && auth === C) return Response.json({ status_code: 429, header: h.retryAfter ? { "rEtRy-AfTeR": [h.retryAfter] } : {}, body: "rate limited" });
		return Response.json({ status_code: 200, body: JSON.stringify({
			five_hour: { utilization: 20 }, rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } },
		}) });
	});
	return h;
}

test("five concurrent collections coalesce discovery and same-account quota", async (t) => {
	const h = setup(t);
	const results = await Promise.all(Array.from({ length: 5 }, () => h.collect()));
	assert.equal(h.list, 1);
	assert.equal(h.models, 1);
	assert.equal(h.usage.get(C), 1);
	assert.equal(h.peak, 1);
	assert.ok(results.every((r) => r.snapshot.windows.get(C)[0].remainingPct === 80));
});

test("every trigger reuses quota for five minutes, then fetches once", async (t) => {
	const h = setup(t);
	await h.collect();
	for (let i = 0; i < 10; i++) await h.collect();
	h.advance(TTL - 1);
	await h.collect();
	assert.equal(h.usage.get(C), 1);
	h.advance(1);
	await h.collect();
	assert.equal(h.usage.get(C), 2);
});

test("upstream Retry-After numeric seconds block manual retries until the deadline", async (t) => {
	const h = setup(t);
	h.mode = "429";
	h.retryAfter = "3600";
	const first = await h.collect();
	assert.equal(first.snapshot.statuses.get(C).retryAt, h.now + 3_600_000);
	for (let i = 0; i < 5; i++) await h.collect();
	h.advance(3_600_000 - 1);
	await h.collect();
	assert.equal(h.usage.get(C), 1);
	h.advance(1);
	h.mode = "success";
	const recovered = await h.collect();
	assert.equal(h.usage.get(C), 2);
	assert.equal(recovered.snapshot.statuses.get(C).error, undefined);
});

test("HTTP-date Retry-After is honored", async (t) => {
	const h = setup(t);
	h.mode = "429";
	h.retryAfter = new Date(h.now + 1_200_000).toUTCString();
	const first = await h.collect();
	assert.equal(first.snapshot.statuses.get(C).retryAt, h.now + 1_200_000);
	h.advance(1_199_999);
	await h.collect();
	assert.equal(h.usage.get(C), 1);
});

test("missing or invalid Retry-After uses bounded exponential backoff", async (t) => {
	const h = setup(t);
	h.mode = "429";
	h.retryAfter = "not-a-date";
	for (const minutes of [5, 10, 20, 40, 60, 60]) {
		const result = await h.collect();
		assert.equal(result.snapshot.statuses.get(C).retryAt - h.now, minutes * 60_000);
		const count = h.usage.get(C);
		await h.collect();
		assert.equal(h.usage.get(C), count);
		h.advance(minutes * 60_000);
	}
});

test("successful recovery resets exponential backoff", async (t) => {
	const h = setup(t);
	h.mode = "429";
	await h.collect();
	h.advance(TTL);
	h.mode = "success";
	await h.collect();
	h.advance(TTL);
	h.mode = "429";
	const result = await h.collect();
	assert.equal(result.snapshot.statuses.get(C).retryAt - h.now, TTL);
});

test("last successful quota survives a 429 and is explicitly marked stale/rate-limited", async (t) => {
	const h = setup(t);
	await h.collect();
	h.advance(TTL);
	h.mode = "429";
	h.retryAfter = "3600";
	const result = await h.collect();
	assert.equal(result.snapshot.windows.get(C)[0].remainingPct, 80);
	assert.ok(result.snapshot.statuses.get(C).stale);
	assert.ok(result.blocks[0].includes("cached, stale"));
	const footer = quotaFooter(result.snapshot, "shared", C, h.now);
	assert.ok(footer.includes("80%"));
	assert.ok(footer.includes("stale; rate limited"));
	assert.ok(footer.includes("↻1h0m"));
	await h.collect();
	assert.equal(h.usage.get(C), 2);
});

test("upstream cooldown is per account, not provider or whole proxy", async (t) => {
	const h = setup(t, true);
	h.mode = "429";
	h.retryAfter = "3600";
	const first = await h.collect();
	assert.equal(h.usage.get(C), 1);
	assert.equal(h.usage.get(O), 1);
	assert.ok(first.snapshot.statuses.get(C).rateLimited);
	assert.equal(first.snapshot.statuses.get(O).rateLimited, false);
	h.advance(TTL);
	await h.collect();
	assert.equal(h.usage.get(C), 1);
	assert.equal(h.usage.get(O), 2);
});

test("outer management 429 blocks subsequent proxy calls, including other accounts and routing", async (t) => {
	const h = setup(t, true);
	h.mode = "outer429";
	const first = await h.collect();
	assert.equal(h.usage.get(C), 1);
	assert.equal(h.usage.get(O), undefined);
	assert.ok(first.snapshot.statuses.get(O).rateLimited);
	h.advance(TTL);
	await h.collect();
	await h.client.routing(BASE, KEY, undefined, true);
	assert.equal(h.list, 1);
	assert.equal(h.usage.get(C), 1);
	h.advance(3_600_000 - TTL);
	h.mode = "success";
	await h.collect();
	assert.equal(h.usage.get(C), 2);
	assert.equal(h.usage.get(O), 1);
});

test("concurrent management 429 responses never shorten an existing cooldown", async (t) => {
	const h = setup(t);
	h.mode = "outer429";
	h.retryAfterByAuth.set(C, "3600");
	h.retryAfterByAuth.set(O, "600");
	const cGate = deferred();
	const oGate = deferred();
	h.quotaGates.set(C, cGate.promise);
	h.quotaGates.set(O, oGate.promise);
	const cRequest = h.collect();
	await setImmediate();
	h.advance(60_000);
	h.files = [{ id: "o", name: "codex.json", provider: "codex", auth_index: O }];
	await h.client.routing(BASE, KEY, undefined, true);
	const oRequest = h.collect();
	await setImmediate();
	assert.equal(h.usage.get(C), 1);
	assert.equal(h.usage.get(O), 1);
	cGate.resolve();
	const cResult = await cRequest;
	const deadline = cResult.snapshot.statuses.get(O).retryAt;
	assert.equal(deadline, h.now + 3_600_000);
	oGate.resolve();
	const oResult = await oRequest;
	assert.equal(oResult.snapshot.statuses.get(O).retryAt, deadline);
});

test("management 429 during discovery establishes a shared cooldown without any quota requests", async (t) => {
	const h = setup(t);
	h.listMode = "429";
	const results = await Promise.allSettled(Array.from({ length: 5 }, () => h.collect()));
	assert.ok(results.every((r) => r.status === "rejected" && r.reason.status === 429));
	await assert.rejects(h.collect(), (error) => error.status === 429);
	assert.equal(h.list, 1);
	assert.equal(h.usage.size, 0);
});

test("cancelled discovery cannot start registry or upstream requests, even if fetch ignores abort", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.listGate = gate.promise;
	const controller = new AbortController();
	const pending = h.collect(controller.signal);
	await setImmediate();
	const rejected = assert.rejects(pending, { name: "AbortError" });
	controller.abort();
	await rejected;
	gate.resolve();
	await setImmediate();
	assert.equal(h.list, 1);
	assert.equal(h.models, 0);
	assert.equal(h.usage.size, 0);
});

test("cancelled collection never starts the next account", async (t) => {
	const h = setup(t, true);
	const gate = deferred();
	h.quotaGate = gate.promise;
	const controller = new AbortController();
	const pending = h.collect(controller.signal);
	await setImmediate();
	assert.equal(h.usage.get(C), 1);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	controller.abort();
	await rejected;
	gate.resolve();
	await setImmediate();
	assert.equal(h.usage.get(O), undefined);
	// An attempt already sent keeps its minimum spacing through cancellation/reload.
	h.quotaGate = undefined;
	await h.collect();
	assert.equal(h.usage.get(C), 1);
});

test("cancelling one subscriber does not abort a shared fetch needed by another", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.quotaGate = gate.promise;
	const controller = new AbortController();
	const first = h.collect(controller.signal);
	const second = h.collect();
	await setImmediate();
	assert.equal(h.usage.get(C), 1);
	const rejected = assert.rejects(first, { name: "AbortError" });
	controller.abort();
	await rejected;
	assert.equal(h.requestSignal.aborted, false);
	gate.resolve();
	const result = await second;
	assert.equal(result.snapshot.windows.get(C)[0].remainingPct, 80);
	assert.equal(h.usage.get(C), 1);
});

test("an already cancelled caller performs no HTTP requests", async (t) => {
	const h = setup(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(h.collect(controller.signal), { name: "AbortError" });
	assert.equal(h.list, 0);
});

test("duplicate auth indexes are fetched only once", async (t) => {
	const h = setup(t);
	h.files.push({ ...h.files[0], id: "duplicate", name: "duplicate.json" });
	await h.collect();
	assert.equal(h.models, 1);
	assert.equal(h.usage.get(C), 1);
});

test("management credentials and proxy URLs have isolated caches", async (t) => {
	const h = setup(t);
	await h.collect();
	await h.client.collect(BASE, "different-offline-key", h.now);
	await h.client.collect("http://mock-other-proxy", KEY, h.now);
	assert.equal(h.usage.get(C), 3);
});

test("shared process state preserves cache across client instances and module reloads", async (t) => {
	const h = setup(t);
	const shared = new Map();
	const a = createQuotaClient({ now: () => h.now }, shared);
	const b = createQuotaClient({ now: () => h.now }, shared);
	await Promise.all([a.collect(BASE, KEY), b.collect(BASE, KEY)]);
	assert.equal(h.usage.get(C), 1);
	await collectQuota("http://mock-reload-cache", KEY);
	const reloaded = await import(`./index.ts?rate-limit-reload=${Date.now()}`);
	await reloaded.collectQuota("http://mock-reload-cache", KEY);
	assert.equal(h.usage.get(C), 2, "reload used the existing process cache");
});

test("429 cooldown also survives a module reload in the same process", async (t) => {
	const h = setup(t);
	h.mode = "429";
	h.retryAfter = "3600";
	const key = "offline-reload-cooldown-key";
	const first = await collectQuota("http://mock-reload-cache", key);
	assert.ok(first.snapshot.statuses.get(C).rateLimited);
	const reloaded = await import(`./index.ts?cooldown-reload=${Date.now()}`);
	await reloaded.collectQuota("http://mock-reload-cache", key);
	assert.equal(h.usage.get(C), 1);
});

test("jitter never shortens minimum spacing or exceeds the fallback cap", async (t) => {
	const h = setup(t);
	h.client = createQuotaClient({ now: () => h.now, random: () => 1 });
	h.mode = "429";
	for (const delay of [6, 12, 24, 48, 60, 60]) {
		const result = await h.collect();
		assert.equal(result.snapshot.statuses.get(C).retryAt - h.now, delay * 60_000);
		h.advance(delay * 60_000);
	}
});

test("oversized finite Retry-After values cannot produce an invalid Date", async (t) => {
	const h = setup(t);
	h.mode = "429";
	h.retryAfter = "999999999999999";
	const result = await h.collect();
	assert.equal(result.snapshot.statuses.get(C).retryAt, 8.64e15);
	assert.doesNotThrow(() => quotaFooter(result.snapshot, "shared", C, h.now));
});

test("Retry-After parser rejects malformed numbers and handles zero/past dates", () => {
	const now = Date.parse("2026-10-08T12:00:00Z");
	assert.equal(retryAfterMs("0", now), 0);
	assert.equal(retryAfterMs("120", now), 120_000);
	assert.equal(retryAfterMs("1.5", now), 1500);
	assert.equal(retryAfterMs("garbage", now), undefined);
	assert.equal(retryAfterMs(undefined, now), undefined);
	assert.equal(retryAfterMs(new Date(now - 1000).toUTCString(), now), 0);
});
