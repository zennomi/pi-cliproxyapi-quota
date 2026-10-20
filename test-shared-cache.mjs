// Fully offline, isolated file-cache and real multi-process tests. Never use a live proxy.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { acquireQuotaLock, createQuotaClient, quotaFooter, resolveModelAuth } from "./index.ts";

const RELAY = "9a0e503ba745404d";
const relayEntry = () => ({ name: "ch-relay", "auth-index": RELAY, "base-url": "http://127.0.0.1:11600/v1?token=secret",
	models: [{ name: "gpt-6-astra", alias: "" }, { name: "original", alias: "friendly" }],
	"api-key-entries": [{ "api-key": "never-persist-api-key" }], headers: { secret: "never-persist-header" } });
function compatSetup(t, entries = [relayEntry()], status = 200) {
	const calls = [];
	let now = NOW;
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const url = new URL(String(input));
		assert.equal(url.origin, BASE);
		if (url.pathname.endsWith("/auth-files")) return Response.json({ files: [] });
		if (url.pathname.endsWith("/openai-compatibility")) return Response.json({ "openai-compatibility": entries }, { status });
		assert.ok(url.pathname.endsWith("/api-call"));
		const call = JSON.parse(options.body);
		calls.push(call);
		assert.equal(call.authIndex, RELAY);
		assert.deepEqual(call.header, { Accept: "application/json" });
		assert.equal(call.method, "GET");
		if (call.url.endsWith("/rate-limit-reset-credits")) return Response.json({ status_code: 200,
			body: JSON.stringify({ available_count: 2, credits: [] }) });
		assert.equal(call.url, "http://127.0.0.1:11600/_gateway/usage");
		return Response.json({ status_code: 200, body: JSON.stringify({ rate_limit: {
			primary_window: { used_percent: 12, limit_window_seconds: 18000 },
			secondary_window: { used_percent: 4, limit_window_seconds: 604800 },
		} }) });
	});
	return { calls, advance(ms) { now += ms; }, client: (cacheDir = false) => createQuotaClient({ cacheDir, now: () => now, random: () => 0 }) };
}

test("compat discovery filters invalid entries, preserves aliases, and isolates adapters", async (t) => {
	const h = compatSetup(t, [relayEntry(), { ...relayEntry(), disabled: true, "auth-index": O },
		{ ...relayEntry(), name: "", "auth-index": O }, { ...relayEntry(), "auth-index": "bad" },
		{ name: "codex", "auth-index": C, "base-url": "https://unrelated.invalid/v1", models: [{ name: "friendly" }] }]);
	const client = h.client();
	const result = await client.collect(BASE, KEY);
	assert.equal(result.snapshot.routes.length, 2);
	assert.equal(resolveModelAuth("gpt-6-astra", result.snapshot.routes).credential.auth_index, RELAY);
	assert.equal(resolveModelAuth("friendly", result.snapshot.routes).kind, "ambiguous");
	assert.equal(resolveModelAuth(null, result.snapshot.routes, RELAY).source, "trace");
	assert.equal(result.snapshot.windows.get(RELAY)[0].remainingPct, 88);
	assert.equal(result.snapshot.manualResets.get(RELAY).availableCount, 2);
	assert.equal(result.snapshot.windows.has(C), false, "compat named codex cannot use OAuth adapter");
	assert.equal(h.calls.length, 2);
	await client.collect(BASE, KEY);
	assert.equal(h.calls.length, 2, "five-minute admission also protects compat accounts");
});

test("compat routing stores only allowlisted metadata and survives a new client", async (t) => {
	const dir = temp(t);
	const h = compatSetup(t);
	await h.client(dir).collect(BASE, KEY);
	const disk = readFileSync(join(scopeDir(dir), "routes.json"), "utf8");
	for (const secret of ["never-persist-api-key", "never-persist-header", "token=secret"]) assert.ok(!disk.includes(secret));
	assert.equal(JSON.parse(disk).routes[0].credential.base_url, "http://127.0.0.1:11600");
	const result = await h.client(dir).collect(BASE, KEY);
	assert.equal(result.snapshot.windows.get(RELAY)[0].remainingPct, 88);
	assert.match(quotaFooter(result.snapshot, "gpt-6-astra"), /^ch-relay 5h/);
	assert.equal(h.calls.length, 2);
});

for (const status of [404, 503, 429]) test("compat registry HTTP " + status, async (t) => {
	const h = compatSetup(t, [], status);
	const client = h.client();
	if (status === 404) assert.deepEqual(await client.routing(BASE, KEY), []);
	else await assert.rejects(client.routing(BASE, KEY), /management HTTP/);
	assert.equal(h.calls.length, 0);
});

const TTL = 300_000;
const NOW = Date.parse("2026-10-17T05:00:00Z");
const C = "1111111111111111";
const O = "2222222222222222";
const BASE = "http://mock-shared-cache";
const KEY = "offline-management-secret";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const scopeDir = (dir, base = BASE, key = KEY) => join(dir, digest(`${base}:${digest(key)}`));
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};
function temp(t) {
	const dir = mkdtempSync(join(tmpdir(), "quota-shared-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function setup(t) {
	const dir = temp(t);
	let now = NOW;
	const h = {
		dir, list: 0, models: 0, usage: 0, resets: 0, used: 20,
		mode: "success", retryAfter: "900", retryAfterByAuth: new Map(), usageGates: new Map(), startedByAuth: new Map(), usageGate: undefined, listGate: undefined,
		started: deferred(), listStarted: deferred(),
		files: [{ id: "c", name: "Claude.json", provider: "claude", auth_index: C, email: "test@example.invalid",
			access_token: "do-not-persist-access-token", refresh_token: "do-not-persist-refresh-token", content: { secret: "raw-auth" } }],
		get now() { return now; }, advance(ms) { now += ms; },
		client() { return createQuotaClient({ cacheDir: dir, now: () => now, random: () => 0 }); },
		collect(client, signal) { return client.collect(BASE, KEY, now, signal); },
	};
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const url = new URL(String(input));
		assert.ok([BASE, "http://mock-other-shared"].includes(url.origin), "no live URL may escape");
		if (url.pathname.endsWith("/openai-compatibility")) return Response.json({ "openai-compatibility": [] });
		if (url.pathname.endsWith("/auth-files")) {
			h.list++;
			h.listStarted.resolve();
			if (h.listGate) await h.listGate;
			if (h.mode === "list429") return Response.json({}, { status: 429, headers: { "Retry-After": h.retryAfter } });
			return Response.json({ files: h.files });
		}
		if (url.pathname.endsWith("/auth-files/models")) {
			h.models++;
			return Response.json({ models: [{ id: "friendly" }] });
		}
		assert.ok(url.pathname.endsWith("/api-call"));
		const request = JSON.parse(options.body);
		if (request.url.includes("cedar_ember=")) {
			h.resets++;
			return Response.json({ status_code: 200, body: JSON.stringify({ cedar_ember: { eligible: true,
				grants: [{ resets_left: 2, resets_total: 2, ends_at: "2026-11-01T00:00:00Z" }] } }) });
		}
		h.usage++;
		h.started.resolve();
		h.startedByAuth.get(request.authIndex)?.resolve();
		if (h.usageGates.has(request.authIndex)) await h.usageGates.get(request.authIndex);
		else if (h.usageGate) await h.usageGate;
		if (h.mode === "outer429") return Response.json({}, { status: 429, headers: { "Retry-After": h.retryAfterByAuth.get(request.authIndex) ?? h.retryAfter } });
		return Response.json({ status_code: h.mode === "429" ? 429 : 200, header: { "Retry-After": h.retryAfter },
			body: JSON.stringify({ five_hour: { utilization: h.used } }) });
	});
	return h;
}

async function child(t) {
	const proc = fork(new URL("./test-shared-cache-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = "";
	proc.stderr.on("data", (s) => { stderr += s; });
	t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
	const exited = once(proc, "exit");
	const [ready] = await once(proc, "message");
	assert.deepEqual(ready, { ready: true }, stderr);
	return { proc, exited, stderr: () => stderr };
}
async function mockServer(t) {
	const h = { usage: 0, list: 0, models: 0, resets: 0, gate: undefined, started: deferred() };
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const data = Buffer.concat(chunks).toString();
		let body;
		if (req.url.endsWith("/openai-compatibility")) {
			body = { "openai-compatibility": [] };
		} else if (req.url.endsWith("/auth-files")) {
			h.list++;
			body = { files: [{ id: "c", name: "Claude.json", provider: "claude", auth_index: C }] };
		} else if (req.url.includes("/auth-files/models?")) {
			h.models++;
			body = { models: [{ id: "friendly" }] };
		} else {
			assert.equal(req.url, "/v0/management/api-call");
			const request = JSON.parse(data);
			if (request.url.includes("cedar_ember=")) {
				h.resets++;
				body = { status_code: 200, body: JSON.stringify({ cedar_ember: { eligible: false, grants: [] } }) };
			} else {
				h.usage++;
				h.started.resolve();
				if (h.gate) await h.gate;
				body = { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 20 } }) };
			}
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => { server.closeAllConnections(); server.close(); });
	return { ...h, get usage() { return h.usage; }, get list() { return h.list; }, get models() { return h.models; },
		get resets() { return h.resets; }, set gate(value) { h.gate = value; },
		base: `http://127.0.0.1:${server.address().port}` };
}

// Lock recovery and cleanup are tested separately from HTTP admission.
test("fresh live lock is busy; release cannot remove a different owner's token", async (t) => {
	const path = join(temp(t), "active.lock");
	const first = await acquireQuotaLock(path);
	assert.ok(first);
	assert.equal(await acquireQuotaLock(path, undefined, 30), undefined);
	writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), token: "replacement", at: Date.now() }));
	first.release();
	assert.equal(JSON.parse(readFileSync(path)).token, "replacement");
});

test("old live-PID and corrupt/empty locks expire without heartbeat", async (t) => {
	const dir = temp(t);
	for (const [name, content] of [["old", JSON.stringify({ pid: process.pid, host: hostname(), token: "old", at: Date.now() })],
		["empty", ""], ["corrupt", "{broken"],
		["object-token", JSON.stringify({ pid: process.pid, host: hostname(), token: {}, at: Date.now() })]]) {
		const path = join(dir, name);
		writeFileSync(path, content);
		const old = new Date(Date.now() - 11_000);
		utimesSync(path, old, old);
		const lock = await acquireQuotaLock(path, undefined, 50);
		assert.ok(lock, name);
		assert.ok(lock.current());
		lock.release();
		assert.equal(readdirSync(dir).length, 0);
	}
});

test("SIGKILL leaves a fresh dead-PID lock which is immediately recoverable", async (t) => {
	const path = join(temp(t), "dead.lock");
	const { proc, exited } = await child(t);
	const locked = once(proc, "message");
	proc.send({ mode: "lock", path });
	assert.deepEqual((await locked)[0], { locked: true });
	proc.kill("SIGKILL");
	await exited;
	const lock = await acquireQuotaLock(path, undefined, 50);
	assert.ok(lock);
	lock.release();
});

test("normal process exit cleans owned locks, even without explicit release", async (t) => {
	const dir = temp(t);
	const { proc, exited } = await child(t);
	proc.send({ mode: "lock", path: join(dir, "exit.lock"), exit: true });
	await exited;
	assert.deepEqual(readdirSync(dir), []);
});

test("two separate L1 clients share discovery, windows and manual resets across restarts", async (t) => {
	const h = setup(t);
	const a = h.client();
	const b = h.client();
	const results = await Promise.all([h.collect(a), h.collect(b)]);
	assert.equal(h.usage, 1);
	assert.equal(h.list, 1);
	assert.equal(h.models, 1);
	assert.equal(h.resets, 1);
	const cached = await h.collect(h.client());
	assert.equal(cached.snapshot.windows.get(C)[0].remainingPct, 80);
	assert.equal(cached.snapshot.manualResets.get(C).availableCount, 2);
	assert.match(quotaFooter(cached.snapshot, "friendly", undefined, h.now), /80%/);
	assert.equal(h.usage, 1);
	assert.ok(results.some((r) => r.snapshot.windows.has(C)));
	h.advance(TTL);
	await Promise.all([h.collect(a), h.collect(b), h.collect(h.client())]);
	assert.equal(h.usage, 2);
	assert.equal(h.list, 2);
});

test("another session returns cached quota immediately while owner refreshes, then reads completion", async (t) => {
	const h = setup(t);
	await h.collect(h.client());
	h.advance(TTL);
	const gate = deferred();
	h.usageGate = gate.promise;
	h.started = deferred();
	const first = h.collect(h.client());
	await h.started.promise;
	const pending = await h.collect(h.client());
	assert.equal(pending.snapshot.windows.get(C)[0].remainingPct, 80);
	assert.equal(pending.snapshot.statuses.get(C).pendingElsewhere, true);
	assert.equal(h.usage, 2);
	h.used = 35;
	gate.resolve();
	await first;
	const done = await h.collect(h.client());
	assert.equal(done.snapshot.windows.get(C)[0].remainingPct, 65);
	assert.equal(done.snapshot.statuses.get(C).pendingElsewhere, false);
	assert.equal(h.usage, 2);
});

test("cold registry in another session returns pending, not NO_CRED, without extra HTTP", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.listGate = gate.promise;
	const first = h.collect(h.client());
	await h.listStarted.promise;
	const second = await h.collect(h.client());
	assert.equal(second.snapshot.routingPending, true);
	assert.match(second.blocks.join("\n"), /pending/);
	assert.equal(h.list, 1);
	assert.equal(h.usage, 0);
	gate.resolve();
	await first;
	assert.equal((await h.collect(h.client())).snapshot.windows.size, 1);
});

test("upstream 429 and exponential failure count are shared, preserving stale successful windows", async (t) => {
	const h = setup(t);
	await h.collect(h.client());
	h.advance(TTL);
	h.mode = "429";
	h.retryAfter = "invalid";
	const first = await h.collect(h.client());
	assert.equal(first.snapshot.statuses.get(C).retryAt, h.now + TTL);
	const second = await h.collect(h.client());
	assert.equal(h.usage, 2);
	assert.equal(second.snapshot.statuses.get(C).stale, true);
	assert.equal(second.snapshot.statuses.get(C).rateLimited, true);
	assert.equal(second.snapshot.windows.get(C)[0].remainingPct, 80);
	h.advance(TTL);
	const third = await h.collect(h.client());
	assert.equal(h.usage, 3);
	assert.equal(third.snapshot.statuses.get(C).retryAt, h.now + 2 * TTL);
});

test("management 429 in A blocks B's accounts and routing, including forced registry refresh", async (t) => {
	const h = setup(t);
	await h.collect(h.client());
	h.advance(TTL);
	h.mode = "outer429";
	h.retryAfter = "3600";
	await h.collect(h.client());
	const before = [h.usage, h.list, h.models];
	const b = h.client();
	const result = await h.collect(b);
	await b.routing(BASE, KEY, undefined, true);
	assert.deepEqual([h.usage, h.list, h.models], before);
	assert.equal(result.snapshot.statuses.get(C).retryAt, h.now + 3_600_000);
});

test("concurrent management 429s never shorten shared cooldown; recovery resets failure count", async (t) => {
	const h = setup(t);
	h.files.push({ id: "o", name: "Other.json", provider: "claude", auth_index: O });
	const gates = [deferred(), deferred()];
	for (const [i, index] of [C, O].entries()) {
		h.usageGates.set(index, gates[i].promise);
		h.startedByAuth.set(index, deferred());
	}
	h.mode = "outer429";
	h.retryAfterByAuth.set(C, "3600");
	h.retryAfterByAuth.set(O, "600");
	const a = h.collect(h.client());
	await h.startedByAuth.get(C).promise;
	const b = h.collect(h.client());
	await h.startedByAuth.get(O).promise;
	gates[0].resolve();
	await a;
	gates[1].resolve();
	await b;
	const result = await h.collect(h.client());
	assert.equal(h.usage, 2);
	assert.equal(result.snapshot.statuses.get(O).retryAt, NOW + 3_600_000);
	h.advance(3_600_000);
	h.mode = "success";
	h.usageGates.clear();
	await h.collect(h.client());
	h.advance(TTL);
	h.mode = "outer429";
	h.retryAfterByAuth.clear();
	h.retryAfter = "invalid";
	const recovered = await h.collect(h.client());
	assert.equal(recovered.snapshot.statuses.get(C).retryAt, h.now + TTL);
});

test("management 429 during cold discovery survives a new process/client", async (t) => {
	const h = setup(t);
	h.mode = "list429";
	await assert.rejects(h.collect(h.client()), /management HTTP 429/);
	await assert.rejects(h.collect(h.client()), /management HTTP 429/);
	assert.equal(h.list, 1);
	assert.equal(h.usage, 0);
});

test("busy live account lock never falls back to an unlocked upstream fetch", async (t) => {
	const h = setup(t);
	await h.collect(h.client());
	h.advance(TTL);
	const path = join(scopeDir(h.dir), "locks", `accounts-${C}.lock`);
	const lock = await acquireQuotaLock(path);
	try {
		const result = await h.collect(h.client());
		assert.equal(h.usage, 1);
		assert.equal(result.snapshot.windows.get(C)[0].remainingPct, 80);
	} finally { lock.release(); }
	await h.collect(h.client());
	assert.equal(h.usage, 2);
});

test("late old completion cannot overwrite the next lease's successful result", async (t) => {
	const h = setup(t);
	const gate = deferred();
	h.usageGate = gate.promise;
	const slow = h.collect(h.client());
	await h.started.promise;
	h.advance(TTL + 1);
	h.usageGate = undefined;
	h.used = 50;
	await h.collect(h.client());
	h.used = 90;
	gate.resolve();
	await slow;
	assert.equal((await h.collect(h.client())).snapshot.windows.get(C)[0].remainingPct, 50);
	assert.equal(h.usage, 2);
});

test("cancellation persists spacing and never starts optional reset or the next account", async (t) => {
	const h = setup(t);
	h.files.push({ id: "o", name: "Other.json", provider: "claude", auth_index: O });
	const gate = deferred();
	h.usageGate = gate.promise;
	const controller = new AbortController();
	const a = h.client();
	const call = h.collect(a, controller.signal);
	await h.started.promise;
	controller.abort();
	await assert.rejects(call, { name: "AbortError" });
	gate.resolve();
	// Let the aborted shared flight persist its result without awaiting a subscriber's cancelled promise.
	for (let i = 0; i < 20; i++) await setImmediate();
	assert.equal(h.usage, 1);
	assert.equal(h.resets, 0);
	h.files.pop();
	// Read only the original account via cached routes/snapshot, not a fresh scan of the second account.
	const b = h.client();
	const routes = await b.routing(BASE, KEY);
	const snapshot = b.snapshot(BASE, KEY, routes);
	assert.equal(snapshot.statuses.get(C).nextFetchAt, NOW + TTL);
	assert.equal(snapshot.statuses.get(C).pendingElsewhere, false);
});

test("invalid JSON cache is ignored and repaired atomically; filesystem failure degrades to L1", async (t) => {
	const h = setup(t);
	const scope = scopeDir(h.dir);
	mkdirSync(join(scope, "accounts"), { recursive: true });
	writeFileSync(join(scope, "routes.json"), "{bad");
	writeFileSync(join(scope, "accounts", `${C}.json`), "{bad");
	await h.collect(h.client());
	assert.equal(h.usage, 1);
	assert.ok(JSON.parse(readFileSync(join(scope, "routes.json"))).routes.length);
	const blocked = join(h.dir, "not-a-directory");
	writeFileSync(blocked, "blocked");
	const memory = createQuotaClient({ cacheDir: blocked, now: () => h.now });
	await h.collect(memory);
	await h.collect(memory);
	assert.equal(h.usage, 2, "unwritable filesystem still has L1 spacing");
});

test("files are private, contain no management/OAuth secrets, and proxy/key scopes are isolated", async (t) => {
	const h = setup(t);
	const client = h.client();
	await h.collect(client);
	await client.collect(BASE, "different-offline-key");
	await client.collect("http://mock-other-shared", KEY);
	assert.equal(h.usage, 3);
	const walk = (path) => readdirSync(path).flatMap((name) => {
		const full = join(path, name);
		if (process.platform !== "win32") assert.equal(statSync(full).mode & 0o077, 0, full);
		return statSync(full).isDirectory() ? walk(full) : [readFileSync(full, "utf8")];
	});
	const text = walk(h.dir).join("\n");
	assert.ok(text.includes("test@example.invalid"));
	for (const secret of [KEY, "different-offline-key", "do-not-persist-access-token", "do-not-persist-refresh-token", "raw-auth"]) {
		assert.ok(!text.includes(secret), secret);
	}
});

test("five real forked processes make exactly one discovery and one quota request", { timeout: 15_000 }, async (t) => {
	const dir = temp(t);
	const server = await mockServer(t);
	const children = await Promise.all(Array.from({ length: 5 }, () => child(t)));
	const messages = children.map(({ proc }) => once(proc, "message"));
	for (const { proc } of children) proc.send({ dir, base: server.base, key: KEY, now: NOW });
	for (const [message] of await Promise.all(messages)) assert.equal(message.done, true, message.error);
	for (const c of children) assert.deepEqual(await c.exited, [0, null], c.stderr());
	assert.equal(server.usage, 1);
	assert.equal(server.resets, 1);
	assert.equal(server.list, 1);
	assert.equal(server.models, 1);
	const cached = await createQuotaClient({ cacheDir: dir, now: () => NOW }).collect(server.base, KEY);
	assert.equal(cached.snapshot.windows.size, 1);
	assert.equal(server.usage, 1);
});

test("SIGKILL mid-HTTP leaves a lease: no immediate retry; exactly one fetch at TTL", { timeout: 15_000 }, async (t) => {
	const dir = temp(t);
	const server = await mockServer(t);
	const gate = deferred();
	server.gate = gate.promise;
	const { proc, exited } = await child(t);
	proc.send({ dir, base: server.base, key: KEY, now: NOW });
	await server.started.promise;
	proc.kill("SIGKILL");
	await exited;
	let now = NOW;
	const client = () => createQuotaClient({ cacheDir: dir, now: () => now, random: () => 0 });
	const pending = await client().collect(server.base, KEY);
	assert.equal(server.usage, 1);
	assert.equal(pending.snapshot.statuses.get(C).pendingElsewhere, true);
	now += 61_000;
	await client().collect(server.base, KEY);
	assert.equal(server.usage, 1, "lease expiry does not bypass five-minute admission spacing");
	server.gate = undefined;
	gate.resolve();
	now = NOW + TTL;
	await Promise.all([client().collect(server.base, KEY), client().collect(server.base, KEY)]);
	assert.equal(server.usage, 2);
});

test("a writer evicted during flush cannot publish its lease or send HTTP", { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
	const dir = temp(t);
	const server = await mockServer(t);
	const scope = scopeDir(dir, server.base);
	const lockPath = join(scope, "locks", `accounts-${C}.lock`);
	const { proc, exited } = await child(t);
	const paused = once(proc, "message");
	proc.send({ dir, base: server.base, key: KEY, now: NOW, pausePrefix: join(scope, "leases", digest(`accounts/${C}`)) });
	const [message] = await paused;
	assert.equal(message.paused, true, message.error);
	const oldLease = JSON.parse(readFileSync(message.staged));
	const old = new Date(Date.now() - 11_000);
	utimesSync(lockPath, old, old);
	const client = () => createQuotaClient({ cacheDir: dir, now: () => NOW + 11_000 });
	const result = await client().collect(server.base, KEY);
	assert.equal(result.snapshot.windows.size, 1);
	assert.equal(server.usage, 1);
	const resumed = once(proc, "message");
	proc.kill("SIGCONT");
	assert.equal((await resumed)[0].done, true);
	assert.deepEqual(await exited, [0, null]);
	assert.equal(server.usage, 1, "old writer checked ownership after flush, before publication/fetch");
	// Simulate the last filesystem race (eviction between final check and rename). A late main-file
	// overwrite still cannot erase a newer lease: immutable per-owner records are the commit fence.
	writeFileSync(join(scope, "accounts", `${C}.json`), JSON.stringify(oldLease));
	assert.equal((await client().collect(server.base, KEY)).snapshot.windows.size, 1);
	assert.equal(server.usage, 1);
});

test("malformed credential/lease fields are rejected without poisoning routing", async (t) => {
	const h = setup(t);
	const scope = scopeDir(h.dir);
	mkdirSync(scope, { recursive: true });
	for (const fields of [{ provider: 42 }, { provider: "claude" }]) {
		writeFileSync(join(scope, "routes.json"), JSON.stringify({ version: 1, routesAt: NOW,
			routeAttemptAt: NOW, routeRetryAt: 0, routeFetchingUntil: fields.provider === 42 ? undefined : "Infinity",
			routes: [{ credential: { id: "c", name: "Claude.json", auth_index: C, ...fields }, modelIds: ["friendly"] }] }));
		// Remove journal snapshots so this test exercises the malformed file, not a valid older cache.
		rmSync(join(scope, "leases"), { recursive: true, force: true });
		const result = await h.collect(h.client());
		assert.equal(result.snapshot.routingPending, false);
		assert.equal(result.snapshot.routes[0].credential.provider, "claude");
	}
	assert.equal(h.list, 2);
});

test("malformed high-deadline journals cannot mask valid admissions or cause repeated fetches", async (t) => {
	const h = setup(t);
	await h.collect(h.client());
	const scope = scopeDir(h.dir);
	const accountDir = join(scope, "leases", digest(`accounts/${C}`));
	writeFileSync(join(accountDir, "bad.json"), JSON.stringify({ version: 1, retryAt: NOW + 3_600_000, failures: "bad", owner: "bad" }));
	writeFileSync(join(scope, "leases", digest("routes"), "bad.json"), JSON.stringify({ version: 1, routesAt: NOW + 3_600_000,
		routeAttemptAt: NOW + 3_600_000, routeRetryAt: 0, routes: [{ credential: { id: "bad", name: "bad", auth_index: C, provider: 42 }, modelIds: [] }] }));
	for (let i = 0; i < 3; i++) {
		const result = await h.collect(h.client());
		assert.equal(result.snapshot.windows.get(C)[0].remainingPct, 80);
		assert.equal(h.usage, 1);
		assert.equal(h.list, 1);
	}
});

test("journal revisions are immutable: pruning an old lease cannot erase its extended 429", async (t) => {
	const h = setup(t);
	h.mode = "429";
	h.retryAfter = "3600";
	await h.collect(h.client());
	const scope = scopeDir(h.dir);
	const journals = join(scope, "leases", digest(`accounts/${C}`));
	const revisions = readdirSync(journals).filter((f) => f.endsWith(".json")).map((f) => ({ path: join(journals, f), value: JSON.parse(readFileSync(join(journals, f))) }));
	const pending = revisions.find((r) => r.value.fetchingUntil);
	const completed = revisions.find((r) => r.value.rateLimited);
	assert.ok(pending && completed);
	assert.equal(pending.value.owner, completed.value.owner);
	assert.notEqual(pending.path, completed.path, "completion must not replace an admission revision");
	h.advance(2 * TTL + 1);
	rmSync(pending.path); // Simulate an expired-revision cleanup racing after the extended cooldown.
	writeFileSync(join(scope, "accounts", `${C}.json`), JSON.stringify(pending.value));
	const result = await h.collect(h.client());
	assert.equal(h.usage, 1);
	assert.equal(result.snapshot.statuses.get(C).retryAt, NOW + 3_600_000);
	assert.equal(result.snapshot.statuses.get(C).rateLimited, true);
});

