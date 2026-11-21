import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { load } from "sqlite-vec";
import type { QueryWorkerRequest, QueryWorkerResponse } from "./query-executor-types.ts";

if (!parentPort) throw new Error("SQLite query worker requires a parent port.");
const port = parentPort;
const { dbPath } = workerData as { dbPath: string };
const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: true });
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
let vectorLoaded = false;

port.on("message", (message: QueryWorkerRequest) => {
	if (message.type === "close") {
		db.close();
		port.close();
		return;
	}
	try {
		if (message.query.vector && !vectorLoaded) {
			load(db);
			vectorLoaded = true;
		}
		const rows = db.prepare(message.query.sql).all(...(message.query.parameters ?? []));
		port.postMessage({ type: "result", rows } satisfies QueryWorkerResponse);
	} catch (error) {
		port.postMessage({
			type: "error",
			error: error instanceof Error ? error : new Error(String(error)),
		} satisfies QueryWorkerResponse);
	}
});
port.postMessage({ type: "ready" } satisfies QueryWorkerResponse);
