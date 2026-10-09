// Offline lifecycle and response-routing tests. Run: node --test test-footer.mjs
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import quotaExtension, { createQuotaClient } from "./index.ts";

const FIVE_MINUTES = 5 * 60_000;
const BASE = "http://127.0.0.1:8317";
const CLAUDE = "1111111111111111";
const SECOND = "2222222222222222";
const CODEX = "3333333333333333";
const trace = (auth) => `20261008235959-${auth}-0199b012-3456-7890-abcd-0123456789ab`;
const proxyModel = (id) => ({ provider: "arbitrary-proxy-name", id, baseUrl: `${BASE}/v1` });

function setup(t) {
	const handlers = new Map();
	const commands = new Map();
	const timers = new Map();
	const statuses = [];
	const notifications = [];
	let now = Date.parse("2026-10-08T12:00:00Z");
	const client = createQuotaClient({ now: () => now, random: () => 0 });
	t.mock.method(Date, "now", () => now);
	let requests = 0;
	let allRequests = 0;
	let latency = 0;
	const usageRequests = new Map();
	const usageTimes = new Map();
	let runStarted = false;
	let fail = false;
	let pause;
	const registryFailures = new Set();
	const quotaFailures = new Set();
	let files = [
		{ id: "claude-1", provider: "claude", auth_index: CLAUDE, name: "Claude.json" },
		{ id: "codex-1", provider: "codex", auth_index: CODEX, name: "Codex.json" },
	];
	const models = new Map([[CLAUDE, ["friendly-alias", "shared"]], [CODEX, ["gpt-5.6-terra", "shared"]]]);

	t.mock.method(globalThis, "setTimeout", (callback, ms) => {
		const handle = { unref: t.mock.fn() };
		timers.set(handle, { callback, ms });
		return handle;
	});
	t.mock.method(globalThis, "clearTimeout", (handle) => timers.delete(handle));
	t.mock.method(globalThis, "fetch", async (input, options) => {
		allRequests++;
		now += latency;
		const url = new URL(String(input));
		if (url.pathname.endsWith("/auth-files")) {
			requests++;
			if (pause) await pause;
			if (fail) throw new Error("offline");
			return Response.json({ files });
		}
		if (url.pathname.endsWith("/auth-files/models")) {
			const cred = files.find((file) => file.name === url.searchParams.get("name"));
			assert.ok(cred, "lookup uses the auth filename");
			if (registryFailures.has(cred.auth_index)) return Response.json({ error: "unavailable" }, { status: 503 });
			return Response.json({ models: (models.get(cred.auth_index) ?? []).map((id) => ({ id })) });
		}
		assert.ok(url.pathname.endsWith("/api-call"));
		const body = JSON.parse(options.body);
		usageRequests.set(body.authIndex, (usageRequests.get(body.authIndex) ?? 0) + 1);
		usageTimes.set(body.authIndex, [...(usageTimes.get(body.authIndex) ?? []), now]);
		if (quotaFailures.has(body.authIndex)) return Response.json({ error: "unavailable" }, { status: 503 });
		return Response.json({ status_code: 200, body: JSON.stringify({
			five_hour: { utilization: body.authIndex === SECOND ? 90 : 20 },
			rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 } },
		}) });
	});
	const originalEnv = ["CLIPROXYAPI_MANAGEMENT_KEY", "CLIPROXYAPI_BASE_URL"].map((name) => [name, process.env[name]]);
	process.env.CLIPROXYAPI_MANAGEMENT_KEY = "mock-key-not-a-secret";
	process.env.CLIPROXYAPI_BASE_URL = BASE;

	const ctx = {
		hasUI: true,
		mode: "tui",
		model: proxyModel("friendly-alias"),
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (_key, text) => statuses.push(text),
			notify: (...args) => notifications.push(args),
		},
	};
	quotaExtension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut: () => {},
	}, client);
	t.after(() => {
		handlers.get("session_shutdown")?.({}, ctx);
		for (const [name, value] of originalEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	return {
		ctx, handlers, commands, timers, statuses, notifications, models, registryFailures, quotaFailures, usageRequests, usageTimes,
		advance(ms) { now += ms; },
		set latency(value) { latency = value; },
		get requests() { return requests; },
		get allRequests() { return allRequests; },
		get footer() { return statuses.at(-1); },
		set files(value) { files = value; },
		set fail(value) { fail = value; },
		set pause(value) { pause = value; },
		async emit(name, context = ctx, event = {}) {
			// Simulate pi's run boundary when a test sends its first provider request.
			if (name === "before_provider_request" && !runStarted) {
				await handlers.get("before_agent_start")?.({}, context);
				runStarted = true;
			}
			if (name === "before_agent_start") runStarted = true;
			if (["session_start", "session_shutdown", "agent_settled"].includes(name)) runStarted = false;
			await handlers.get(name)?.(event, context);
			await setImmediate();
		},
		async response(auth, context = ctx, status = 200) {
			await this.emit("after_provider_response", context, { status, headers: auth ? { "x-cpa-trace-id": trace(auth) } : {} });
		},
		async poll() {
			const [handle, { callback, ms }] = [...timers.entries()][0];
			now += ms;
			timers.delete(handle);
			callback();
			await setImmediate();
		},
		async tick() {
			now += FIVE_MINUTES;
			for (const [handle, { callback, ms }] of [...timers.entries()]) {
				assert.equal(ms, FIVE_MINUTES);
				timers.delete(handle);
				callback();
			}
			await setImmediate();
		},
	};
}

test("load and idle 5-minute polling use runtime registry, not model names", async (t) => {
	const h = setup(t);
	assert.equal(h.timers.size, 0, "no timer started in factory");
	await h.emit("session_start");
	assert.equal(h.requests, 1);
	assert.ok(h.footer.startsWith("Quota[claude] 5h"));
	assert.equal(h.timers.size, 1);
	assert.equal([...h.timers.keys()][0].unref.mock.callCount(), 1);
	await h.emit("before_agent_start");
	await h.emit("agent_settled");
	assert.equal(h.requests, 1, "turn events do not fetch quota");
	await h.tick();
	await h.tick();
	assert.equal(h.requests, 3);
	assert.equal(h.notifications.length, 0);
});

test("model switches replace timers, clear old auth immediately, and session shutdown is idempotent", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	const firstTimer = [...h.timers.keys()][0];
	await h.emit("before_provider_request");
	await h.response(CLAUDE);
	const codexCtx = { ...h.ctx, model: proxyModel("gpt-5.6-terra") };
	await h.emit("model_select", codexCtx);
	assert.equal(h.timers.size, 1);
	assert.ok(!h.timers.has(firstTimer));
	assert.ok(h.footer.startsWith("Quota[codex]"));
	await h.response(CLAUDE, codexCtx); // late response, with no request for the new model
	assert.ok(h.footer.startsWith("Quota[codex]"));
	await h.tick();
	assert.ok(h.footer.startsWith("Quota[codex]"));
	await h.emit("session_start");
	assert.equal(h.timers.size, 1);
	assert.ok(h.footer.startsWith("Quota[claude]"));
	await h.emit("session_shutdown");
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
	assert.equal(h.footer, undefined);
	const before = h.requests;
	await h.tick();
	assert.equal(h.requests, before);
});

test("headless/RPC and direct-provider sessions do not poll or display proxy quota", async (t) => {
	const h = setup(t);
	await h.emit("session_start", { ...h.ctx, hasUI: false, mode: "print" });
	await h.emit("session_start", { ...h.ctx, mode: "rpc" });
	await h.emit("session_start", { ...h.ctx, model: { provider: "anthropic", id: "friendly-alias", baseUrl: "https://api.anthropic.com" } });
	assert.equal(h.timers.size, 0);
	assert.equal(h.requests, 0);
	assert.equal(h.footer, undefined);
	await h.emit("session_start");
	await h.emit("model_select", { ...h.ctx, model: { ...proxyModel("friendly-alias"), baseUrl: "http://localhost:9999/v1" } });
	assert.equal(h.timers.size, 0);
	assert.equal(h.footer, undefined);
});

test("manual quota stays immediate; failed polls recover silently", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.commands.get("quota").handler("", h.ctx);
	assert.equal(h.requests, 1, "manual quota reuses fresh routing and account quota");
	assert.equal(h.usageRequests.get(CLAUDE), 1);
	assert.equal(h.notifications.length, 2);
	const count = h.statuses.length;
	h.fail = true;
	await h.tick();
	assert.equal(h.statuses.length, count);
	assert.equal(h.notifications.length, 2);
	h.fail = false;
	await h.tick();
	assert.equal(h.statuses.length, count + 1);
});

test("shared model remains pending until a trace selects the real provider without network I/O", async (t) => {
	const h = setup(t);
	h.ctx.model = proxyModel("shared");
	await h.emit("session_start");
	assert.equal(h.footer, "Quota[claude/codex] auth pending (2 accounts)");
	await h.emit("before_provider_request");
	const requests = h.allRequests;
	await h.response(CODEX);
	assert.ok(h.footer.startsWith("Quota[codex] 5h ━━━━── 60%"));
	assert.equal(h.allRequests, requests, "header observation does not block on fetching quota");
	await h.tick();
	assert.ok(h.footer.startsWith("Quota[codex]"), "periodic refresh retains selected auth");
	await h.emit("before_provider_request");
	assert.equal(h.footer, "Quota[claude/codex] auth pending (2 accounts)");
	await h.response(CLAUDE);
	assert.ok(h.footer.startsWith("Quota[claude] 5h ━━━━━─ 80%"));
});

test("same-provider accounts keep separate quota windows and never choose the first account", async (t) => {
	const h = setup(t);
	h.files = [
		{ id: "first", name: "first.json", provider: "claude", auth_index: CLAUDE },
		{ id: "second", name: "second.json", provider: "claude", auth_index: SECOND },
	];
	h.models.set(SECOND, ["friendly-alias"]);
	await h.emit("session_start");
	assert.equal(h.footer, "Quota[claude] auth pending (2 accounts)");
	await h.emit("before_provider_request");
	await h.response(SECOND);
	assert.ok(h.footer.startsWith("Quota[claude:22222222] 5h ━───── 10%"));
	await h.tick();
	assert.ok(h.footer.includes("10%"));
});

test("missing, malformed and unsuccessful traces clear previous selection", async (t) => {
	const h = setup(t);
	h.ctx.model = proxyModel("shared");
	await h.emit("session_start");
	await h.emit("before_provider_request");
	await h.response(CODEX);
	await h.response(null);
	assert.ok(h.footer.includes("auth pending"));
	await h.response(CODEX);
	await h.emit("after_provider_response", h.ctx, { status: 200, headers: { "x-cpa-trace-id": "malformed" } });
	assert.ok(h.footer.includes("auth pending"));
	await h.response(CODEX);
	await h.response(CLAUDE, h.ctx, 503);
	assert.ok(h.footer.includes("auth pending"));
});

test("unknown trace auth refreshes credentials but does not fall back to a known account", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.emit("before_provider_request");
	await h.response("9999999999999999");
	assert.equal(h.footer, "Quota auth unknown");
	assert.equal(h.requests, 1, "unknown-auth discovery is throttled after startup and never fetches quota");
	assert.equal(h.usageRequests.get(CLAUDE), 1);
});

test("refresh completing after a trace uses the latest selected auth", async (t) => {
	const h = setup(t);
	h.ctx.model = proxyModel("shared");
	await h.emit("session_start");
	let release;
	h.pause = new Promise((resolve) => { release = resolve; });
	await h.tick();
	await h.emit("before_provider_request");
	await h.response(CODEX);
	release();
	await setImmediate();
	assert.ok(h.footer.startsWith("Quota[codex]"));
});

test("late quota and trace responses cannot update a shut-down session", async (t) => {
	const h = setup(t);
	let release;
	h.pause = new Promise((resolve) => { release = resolve; });
	await h.emit("session_start");
	await h.emit("before_provider_request");
	await h.emit("session_shutdown");
	const count = h.statuses.length;
	release();
	await setImmediate();
	await h.response(CODEX);
	assert.equal(h.statuses.length, count);
	assert.equal(h.footer, undefined);
	assert.equal(h.timers.size, 0);
});

test("partial registry failures stay unknown, but a valid trace can still resolve the credential", async (t) => {
	const h = setup(t);
	h.registryFailures.add(CODEX);
	await h.emit("session_start");
	assert.equal(h.footer, "Quota routing unavailable");
	await h.emit("before_provider_request");
	await h.response(CLAUDE);
	assert.ok(h.footer.startsWith("Quota[claude]"));
});

test("a selected account's quota error never displays another account's quota", async (t) => {
	const h = setup(t);
	h.quotaFailures.add(CLAUDE);
	await h.emit("session_start");
	assert.ok(h.footer.startsWith("Quota[claude] n/a · refresh failed"));
	await h.emit("before_provider_request");
	await h.response(CLAUDE);
	assert.ok(h.footer.startsWith("Quota[claude] n/a · refresh failed"));
});

test("credentials without quota adapters still participate in routing ambiguity", async (t) => {
	const h = setup(t);
	h.files = [
		{ id: "claude", name: "claude.json", provider: "claude", auth_index: CLAUDE },
		{ id: "custom", name: "custom.json", provider: "custom-provider", auth_index: SECOND },
	];
	h.models.set(SECOND, ["friendly-alias"]);
	await h.emit("session_start");
	assert.equal(h.footer, "Quota[claude/custom-provider] auth pending (2 accounts)");
	await h.emit("before_provider_request");
	await h.response(SECOND);
	assert.equal(h.footer, "Quota[custom-provider] n/a");
});

test("disabled and index-less credentials do not affect discovery", async (t) => {
	const h = setup(t);
	h.files = [
		{ id: "claude", name: "claude.json", provider: "claude", auth_index: CLAUDE },
		{ id: "disabled", name: "disabled.json", provider: "codex", auth_index: SECOND, disabled: true },
		{ id: "no-index", name: "no-index.json", provider: "codex" },
	];
	h.models.set(SECOND, ["friendly-alias"]);
	await h.emit("session_start");
	assert.ok(h.footer.startsWith("Quota[claude]"));
	assert.equal(h.allRequests, 3, "one list, one registry, one quota request");
});

test("removing all credentials clears previously cached account quota", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.emit("before_provider_request");
	await h.response(CLAUDE);
	assert.ok(h.footer.startsWith("Quota[claude]"));
	h.files = [];
	await h.tick();
	assert.equal(h.footer, "Quota routing unavailable");
});

test("headless trace observation never starts automatic management requests", async (t) => {
	const h = setup(t);
	const headless = { ...h.ctx, hasUI: false, mode: "print" };
	await h.emit("session_start", headless);
	await h.emit("before_provider_request", headless);
	await h.response(CLAUDE, headless);
	assert.equal(h.allRequests, 0);
});

test("an old request prepared after model_select cannot be attributed to the newly selected model", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.emit("before_agent_start"); // Run A starts preparing a request for friendly-alias.
	h.ctx.model = proxyModel("gpt-5.6-terra"); // Context getters now expose model B.
	await h.emit("model_select");
	assert.ok(h.footer.startsWith("Quota[codex]"));
	// Even a protocol with no model field must reject the entire switched run.
	await h.emit("before_provider_request", h.ctx, { payload: {} });
	await h.response(CLAUDE);
	assert.ok(h.footer.startsWith("Quota[codex]"));
	// A later, genuinely new run can resolve traces again.
	await h.emit("agent_settled");
	await h.emit("before_provider_request", h.ctx, { payload: { model: "gpt-5.6-terra" } });
	await h.response(CODEX);
	assert.ok(h.footer.startsWith("Quota[codex]"));
});

test("idle cache warming without a new run preserves the last safely selected auth", async (t) => {
	const h = setup(t);
	h.ctx.model = proxyModel("shared");
	await h.emit("session_start");
	await h.emit("before_provider_request");
	await h.response(CODEX);
	await h.emit("agent_settled");
	const footer = h.footer;
	const requests = h.allRequests;
	// Bypass the helper: pi cache warming does NOT emit before_agent_start.
	await h.handlers.get("before_provider_request")({ payload: { model: "shared" } }, h.ctx);
	await h.response(CLAUDE);
	assert.equal(h.footer, footer);
	assert.ok(h.footer.startsWith("Quota[codex]"));
	assert.equal(h.allRequests, requests);
});

test("outgoing payload model mismatches cannot overwrite the current model's auth", async (t) => {
	const h = setup(t);
	h.ctx.model = proxyModel("gpt-5.6-terra");
	await h.emit("session_start");
	await h.emit("before_provider_request", h.ctx, { payload: { model: "friendly-alias" } });
	await h.response(CLAUDE);
	assert.ok(h.footer.startsWith("Quota[codex]"));
});

test("request latency does not turn five-minute polling into ten-minute polling", async (t) => {
	const h = setup(t);
	h.latency = 50;
	await h.emit("session_start");
	assert.equal(h.usageRequests.get(CLAUDE), 1);
	await h.poll();
	assert.equal(h.usageRequests.get(CLAUDE), 2);
	await h.poll();
	assert.equal(h.usageRequests.get(CLAUDE), 3);
	const times = h.usageTimes.get(CLAUDE);
	for (let i = 1; i < times.length; i++) {
		assert.ok(times[i] - times[i - 1] >= FIVE_MINUTES);
		assert.ok(times[i] - times[i - 1] < FIVE_MINUTES + 1000);
	}
	assert.equal(h.timers.size, 1, "one adaptive poll remains scheduled");
});

test("rapid model switches do not generate additional upstream usage requests", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	for (let i = 0; i < 10; i++) {
		await h.emit("model_select", { ...h.ctx, model: proxyModel(i % 2 ? "friendly-alias" : "gpt-5.6-terra") });
	}
	assert.equal(h.usageRequests.get(CLAUDE), 1);
	assert.equal(h.usageRequests.get(CODEX), 1);
	assert.equal(h.requests, 1, "fresh routing is reused too");
});

test("repeated unknown traces perform only throttled local discovery", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	h.advance(60_000);
	await h.emit("before_provider_request");
	for (let i = 0; i < 10; i++) await h.response("9999999999999999");
	assert.equal(h.requests, 2, "one additional discovery for all ten responses");
	assert.equal(h.usageRequests.get(CLAUDE), 1);
	assert.equal(h.usageRequests.get(CODEX), 1);
	assert.equal(h.footer, "Quota auth unknown");
});

test("discovering a new trace auth does not refetch existing account quota", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	h.advance(60_000);
	h.files = [
		{ id: "claude", name: "claude.json", provider: "claude", auth_index: CLAUDE },
		{ id: "second", name: "second.json", provider: "claude", auth_index: SECOND },
	];
	h.models.set(SECOND, ["friendly-alias"]);
	await h.emit("before_provider_request");
	await h.response(SECOND);
	assert.ok(h.footer.startsWith("Quota[claude:22222222] n/a"));
	assert.equal(h.usageRequests.get(CLAUDE), 1);
	assert.equal(h.usageRequests.get(SECOND), undefined);
	await h.commands.get("quota").handler("", h.ctx);
	assert.equal(h.usageRequests.get(CLAUDE), 1);
	assert.equal(h.usageRequests.get(SECOND), 1);
	assert.ok(h.footer.includes("10%"));
});

test("management-key changes cancel old manual work before it can fetch quota", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	h.advance(FIVE_MINUTES);
	let release;
	h.pause = new Promise((resolve) => { release = resolve; });
	const pending = h.commands.get("quota").handler("", h.ctx);
	await setImmediate();
	process.env.CLIPROXYAPI_MANAGEMENT_KEY = "different-offline-key";
	h.pause = undefined;
	await h.emit("model_select");
	release();
	await pending;
	await setImmediate();
	assert.equal(h.usageRequests.get(CLAUDE), 1, "old collection issued no new upstream request");
});

test("shutdown during discovery prevents any subsequent upstream quota request", async (t) => {
	const h = setup(t);
	let release;
	h.pause = new Promise((resolve) => { release = resolve; });
	await h.emit("session_start");
	await h.emit("session_shutdown");
	release();
	await setImmediate();
	assert.equal(h.usageRequests.size, 0);
	assert.equal(h.allRequests, 1, "not even per-auth model discovery starts after shutdown");
});

test("old quota refresh cannot overwrite a newly selected model", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	let release;
	h.pause = new Promise((resolve) => { release = resolve; });
	await h.tick();
	const newCtx = { ...h.ctx, model: proxyModel("shared") };
	h.pause = undefined;
	await h.emit("model_select", newCtx);
	assert.ok(h.footer.includes("auth pending"));
	release();
	await setImmediate();
	assert.ok(h.footer.includes("auth pending"));
});
