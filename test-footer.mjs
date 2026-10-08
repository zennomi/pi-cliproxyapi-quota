// Offline footer lifecycle tests. Run: node --test test-footer.mjs
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import quotaExtension from "./index.ts";

const FIVE_MINUTES = 5 * 60_000;

function setup(t) {
	const handlers = new Map();
	const commands = new Map();
	const timers = new Map();
	const statuses = [];
	const notifications = [];
	let requests = 0;
	let fail = false;

	// Fake interval handles also let us verify cleanup and unref without waiting.
	t.mock.method(globalThis, "setInterval", (callback, ms) => {
		const handle = { unref: t.mock.fn() };
		timers.set(handle, { callback, ms });
		return handle;
	});
	t.mock.method(globalThis, "clearInterval", (handle) => timers.delete(handle));
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = String(input);
		if (url.endsWith("/auth-files")) {
			requests++;
			if (fail) throw new Error("offline");
			return Response.json({ files: [
				{ provider: "claude", auth_index: "mock-claude", name: "Claude" },
				{ provider: "codex", auth_index: "mock-codex", name: "Codex" },
			] });
		}
		assert.ok(url.endsWith("/api-call"));
		return Response.json({ status_code: 200, body: JSON.stringify({
			five_hour: { utilization: 20 },
			rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000 } },
		}) });
	});
	const originalKey = process.env.CLIPROXYAPI_MANAGEMENT_KEY;
	process.env.CLIPROXYAPI_MANAGEMENT_KEY = "mock-key-not-a-secret";
	t.after(() => {
		handlers.get("session_shutdown")?.({}, ctx);
		if (originalKey === undefined) delete process.env.CLIPROXYAPI_MANAGEMENT_KEY;
		else process.env.CLIPROXYAPI_MANAGEMENT_KEY = originalKey;
	});

	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { provider: "anthropic", id: "claude-sonnet" },
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
	});
	return {
		ctx, handlers, commands, timers, statuses, notifications,
		get requests() { return requests; },
		set fail(value) { fail = value; },
		async emit(name, context = ctx) {
			await handlers.get(name)?.({}, context);
			await setImmediate();
		},
		async tick() {
			for (const { callback, ms } of [...timers.values()]) {
				assert.equal(ms, FIVE_MINUTES);
				callback();
			}
			await setImmediate();
		},
	};
}

test("footer refreshes on load and every 5 minutes without turns", async (t) => {
	const h = setup(t);
	assert.equal(h.timers.size, 0, "no timer started in extension factory");
	await h.emit("session_start");
	assert.equal(h.requests, 1);
	assert.equal(h.statuses.length, 1);
	assert.equal(h.timers.size, 1);
	assert.equal([...h.timers.keys()][0].unref.mock.callCount(), 1);
	await h.emit("before_agent_start");
	await h.emit("agent_settled");
	assert.equal(h.requests, 1, "turn events no longer fetch quota");
	await h.tick();
	await h.tick();
	assert.equal(h.requests, 3);
	assert.equal(h.statuses.length, 3);
	assert.equal(h.notifications.length, 0, "periodic refresh is silent");
});

test("session restarts and model switches replace the timer and context", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	const firstTimer = [...h.timers.keys()][0];
	const codexCtx = { ...h.ctx, model: { provider: "openai", id: "gpt-5" } };
	await h.emit("model_select", codexCtx);
	assert.equal(h.timers.size, 1);
	assert.ok(!h.timers.has(firstTimer));
	assert.ok(h.statuses.at(-1).startsWith("Quota[codex]"));
	await h.tick();
	assert.ok(h.statuses.at(-1).startsWith("Quota[codex]"));
	await h.emit("session_start");
	assert.equal(h.timers.size, 1);
	assert.ok(h.statuses.at(-1).startsWith("Quota[claude]"));
	await h.emit("session_shutdown");
	await h.emit("session_shutdown");
	assert.equal(h.timers.size, 0);
	const before = h.requests;
	await h.tick();
	assert.equal(h.requests, before);
});

test("headless/RPC sessions do not poll quota", async (t) => {
	const h = setup(t);
	await h.emit("session_start", { ...h.ctx, hasUI: false, mode: "print" });
	await h.emit("session_start", { ...h.ctx, mode: "rpc" });
	assert.equal(h.timers.size, 0);
	assert.equal(h.requests, 0);
});

test("manual quota stays immediate and failed polls recover silently", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.commands.get("quota").handler("", h.ctx);
	assert.equal(h.requests, 2);
	assert.equal(h.notifications.length, 2);
	h.fail = true;
	await h.tick();
	assert.equal(h.statuses.length, 2);
	assert.equal(h.notifications.length, 2);
	h.fail = false;
	await h.tick();
	assert.equal(h.statuses.length, 3);
});

test("late responses cannot update the footer after shutdown", async (t) => {
	const h = setup(t);
	h.handlers.get("session_start")({}, h.ctx);
	await h.emit("session_shutdown");
	assert.equal(h.statuses.length, 0);
	assert.equal(h.timers.size, 0);
});
