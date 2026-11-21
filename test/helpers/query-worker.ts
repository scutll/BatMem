import { parentPort, threadId } from "node:worker_threads";
import type { QueryWorkerRequest, QueryWorkerResponse } from "../../src/storage/query-executor-types.ts";

if (!parentPort) throw new Error("Test worker requires a parent port.");
const port = parentPort;
port.on("message", (message: QueryWorkerRequest) => {
	if (message.type === "close") { port.close(); return; }
	if (message.query.sql === "exit") { process.exit(0); }
	try {
		const counter = message.query.parameters?.[0];
		if (!(counter instanceof Int32Array)) throw new Error("Expected a shared barrier.");
		Atomics.add(counter, 0, 1);
		Atomics.notify(counter, 0);
		// Neither request can complete until another worker enters the same barrier.
		while (Atomics.load(counter, 0) < 2) {
			if (Atomics.wait(counter, 0, 1, 2000) === "timed-out") throw new Error("Queries did not overlap.");
		}
		port.postMessage({ type: "result", rows: [{ threadId }] } satisfies QueryWorkerResponse);
	} catch (error) {
		port.postMessage({ type: "error", error: error instanceof Error ? error : new Error(String(error)) } satisfies QueryWorkerResponse);
	}
});
port.postMessage({ type: "ready" } satisfies QueryWorkerResponse);
