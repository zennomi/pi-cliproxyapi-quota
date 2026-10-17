// Child fixture for test-shared-cache.mjs. All URLs are supplied by its loopback-only mock server.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { acquireQuotaLock, createQuotaClient } from "./index.ts";

process.on("message", async (message) => {
	try {
		if (message.mode === "lock") {
			const lock = await acquireQuotaLock(message.path);
			if (!lock) throw new Error("fixture lock unavailable");
			process.send({ locked: true });
			if (message.exit) process.exit(0); // Exit cleanup, deliberately without release().
			return;
		}
		if (message.pausePrefix) {
			const write = fs.writeFileSync;
			let paused = false;
			fs.writeFileSync = function (path, ...args) {
				const result = write.call(this, path, ...args);
				if (!paused && typeof path === "string" && path.startsWith(message.pausePrefix)) {
					paused = true;
					process.send({ paused: true, staged: path });
					process.kill(process.pid, "SIGSTOP"); // Parent evicts us while the flushed write is stalled.
				}
				return result;
			};
			syncBuiltinESMExports();
		}
		const client = createQuotaClient({ cacheDir: message.dir, now: () => message.now, random: () => 0 });
		const { snapshot } = await client.collect(message.base, message.key);
		process.send({ done: true, accounts: snapshot.windows.size, pending: snapshot.routingPending });
		process.disconnect();
	} catch (error) {
		process.send({ error: error.message });
		process.exitCode = 1;
		process.disconnect();
	}
});
process.send({ ready: true });
