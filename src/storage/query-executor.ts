import { Worker } from "node:worker_threads";
import type {
	QueryExecutor,
	QueryRows,
	QueryWorkerRequest,
	QueryWorkerResponse,
	SQLiteQuery,
} from "./query-executor-types.ts";

interface PendingQuery {
	query: SQLiteQuery;
	resolve: (rows: QueryRows) => void;
	reject: (error: Error) => void;
}

interface QueryWorker {
	worker: Worker;
	ready: boolean;
	stopping: boolean;
	current?: PendingQuery;
	exited: Promise<void>;
}

/** Fixed, lazily started workers. Every worker owns a persistent read-only SQLite connection. */
export class SQLiteQueryExecutor implements QueryExecutor {
	private readonly dbPath: string;
	private readonly workerCount: number;
	private readonly workerURL: URL;
	private readonly workers: QueryWorker[] = [];
	private readonly queue: PendingQuery[] = [];
	private closing?: Promise<void>;
	private finishDrain?: () => void;
	private failure?: Error;

	constructor(dbPath: string, workerCount = 4, workerURL = new URL("./query-worker.ts", import.meta.url)) {
		if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error("Query worker count must be positive.");
		this.dbPath = dbPath;
		this.workerCount = workerCount;
		this.workerURL = workerURL;
	}

	execute(query: SQLiteQuery): Promise<QueryRows> {
		if (this.closing) return Promise.reject(new Error("Query executor is closed."));
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			// Capture mutable parameters before the request enters the queue.
			this.queue.push({ query: structuredClone(query), resolve, reject });
			try {
				this.start();
				this.dispatch();
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): Promise<void> {
		if (!this.closing) {
			const drained = new Promise<void>((resolve) => {
				this.finishDrain = resolve;
			});
			this.closing = drained.then(async () => {
				await Promise.all(this.workers.map(({ exited }) => exited));
			});
			if (this.failure) this.finishDrain?.();
			else this.dispatch();
		}
		return this.closing;
	}

	private start(): void {

		// create new workers when workers less than workerCount or task count + active workers count
		const needed = Math.min(this.workerCount, this.queue.length + this.workers.filter((state) => state.current).length);
		while (this.workers.length < needed) {
			const worker = new Worker(this.workerURL, { workerData: { dbPath: this.dbPath } });
			const state: QueryWorker = { worker, ready: false, stopping: false, exited: Promise.resolve() };
			state.exited = new Promise<void>((resolve) => {
				worker.once("exit", (code) => {
					if (!state.stopping && !this.failure)
						this.fail(new Error(`Query worker exited unexpectedly (code ${code}).`));
					resolve();
				});
			});
			this.workers.push(state);
			worker.on("error", (error) => this.fail(error));
			/**
			 * parent process listens from worker message result and resolve to the promise to bm25/vector retriever
			 */
			worker.on("message", (message: QueryWorkerResponse) => {
				if (this.failure || state.stopping) return;
				if (message.type === "ready") state.ready = true;
				else {
					const current = state.current;
					if (!current) {
						this.fail(new Error("Unexpected query worker response."));
						return;
					}
					state.current = undefined;
					if (message.type === "result") current.resolve(message.rows);
					else current.reject(message.error);
				}
				this.dispatch();
			});
		}
	}

	private dispatch(): void {
		if (this.failure) return;
		for (const state of this.workers) {
			if (!state.ready || state.current) continue;
			const next = this.queue.shift();
			if (!next) continue;
			state.current = next;
			try {
				state.worker.postMessage({ type: "query", query: next.query } satisfies QueryWorkerRequest);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
		if (this.closing && !this.queue.length && this.workers.every((state) => !state.current)) {
			for (const state of this.workers) {
				if (state.stopping) continue;
				state.stopping = true;
				state.ready = false;
				state.worker.postMessage({ type: "close" } satisfies QueryWorkerRequest);
			}
			this.finishDrain?.();
			this.finishDrain = undefined;
		}
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const pending of this.queue.splice(0)) pending.reject(error);
		for (const state of this.workers) {
			state.current?.reject(error);
			state.current = undefined;
			void state.worker.terminate();
		}
		this.finishDrain?.();
	}
}
