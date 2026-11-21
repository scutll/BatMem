import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import type { Database } from "../../src/storage/database.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { SQLiteQueryExecutor } from "../../src/storage/query-executor.ts";
import { BM25Retriever } from "../../src/retrieval/recall/utils/bm25.ts";
import { VectorRetriever } from "../../src/retrieval/recall/utils/vector.ts";
import { VectorIndex } from "../../src/storage/vector-index.ts";
import type { EmbeddingProvider } from "../../src/models/embedding/provider.ts";

let directory: string;
let db: Database;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "batmem-executor-"));
	db = openDatabase(join(directory, "index.db"), { workers: 2 });
});
afterEach(async () => {
	await db.close();
	await rm(directory, { recursive: true, force: true });
});

it("runs two tasks on different workers concurrently", { timeout: 10000 }, async () => {
	const executor = new SQLiteQueryExecutor("unused", 2, new URL("../helpers/query-worker.ts", import.meta.url));
	try {
		const counter = new Int32Array(new SharedArrayBuffer(4));
		const results = await Promise.all([
			executor.execute({ sql: "barrier", parameters: [counter] }),
			executor.execute({ sql: "barrier", parameters: [counter] }),
		]);
		assert.equal(Atomics.load(counter, 0), 2);
		assert.notEqual(results[0][0].threadId, results[1][0].threadId);
	} finally { await executor.close(); }
});

it("drains queued queries on close and rejects further submissions", async () => {
	db.prepare("INSERT INTO sessions VALUES ('one', 'one.jsonl', 'project')").run();
	db.prepare("INSERT INTO summaries VALUES ('one', 'entry', 'quasar', '2026-01-01')").run();
	const bm25 = new BM25Retriever(db, "memory");
	const pending = Array.from({ length: 12 }, () => bm25.retrieve({ query: "quasar", topK: 1 }));
	const closed = db.close();
	assert.equal(db.close(), closed);
	await assert.rejects(bm25.retrieve({ query: "quasar", topK: 1 }), /closed/);
	for (const hits of await Promise.all(pending)) assert.equal(hits[0].sourceId, "one");
	await closed;
	assert.equal(db.isOpen, false);
});

it("uses read-only connections and propagates SQL errors without poisoning later queries", async () => {
	await assert.rejects(db.executor.execute({ sql: "DELETE FROM sessions" }), /readonly|read-only/i);
	await assert.rejects(db.executor.execute({ sql: "SELECT * FROM missing_table" }), /missing_table/);
	const [row] = await db.executor.execute({ sql: "SELECT ? AS value", parameters: ["still working"] });
	assert.equal(row.value, "still working");
});

it("keeps concurrent requests on one BM25 instance isolated and sees later commits", async () => {
	for (const term of ["quasar", "nebula"]) {
		db.prepare("INSERT INTO sessions VALUES (?, ?, 'project')").run(term, `${term}.jsonl`);
		db.prepare("INSERT INTO summaries VALUES (?, 'entry', ?, '2026-01-01')").run(term, term);
	}
	const bm25 = new BM25Retriever(db, "memory");
	const terms = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? "quasar" : "nebula");
	const results = await Promise.all(terms.map((query) => bm25.retrieve({ query, topK: 1 })));
	assert.deepEqual(results.map((hits) => hits[0].sourceId), terms);
	db.prepare("UPDATE summaries SET content = 'changed' WHERE session_id = 'quasar'").run();
	assert.deepEqual(await bm25.retrieve({ query: "quasar", topK: 1 }), []);
	assert.equal((await bm25.retrieve({ query: "changed", topK: 1 }))[0].sourceId, "quasar");
});

it("rejects active, queued and future tasks when a worker exits unexpectedly, even during close", async () => {
	const executor = new SQLiteQueryExecutor("unused", 1, new URL("../helpers/query-worker.ts", import.meta.url));
	const settled = Promise.allSettled([
		executor.execute({ sql: "exit" }),
		executor.execute({ sql: "queued" }),
	]);
	await executor.close();
	const results = await settled;
	assert.ok(results.every((result) => result.status === "rejected"));
	await assert.rejects(executor.execute({ sql: "later" }), /closed/);
});

it("surfaces startup failure and can close afterward", async () => {
	const executor = new SQLiteQueryExecutor(join(directory, "missing.db"), 1);
	await assert.rejects(executor.execute({ sql: "SELECT 1" }));
	await executor.close();
});

it("keeps the main event loop responsive while SQLite is computing", async () => {
	await db.executor.execute({ sql: "SELECT 1" });
	let completed = false;
	const pending = db.executor.execute({
		sql: `WITH RECURSIVE numbers(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000)
			SELECT sum(n) AS total FROM numbers`,
	}).then((rows) => { completed = true; return rows; });
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(completed, false);
	assert.equal((await pending)[0].total, 500000500000);
});

it("rechecks vector completeness after embedding without moving provider calls into workers", async () => {
	db.prepare("INSERT INTO documents VALUES ('doc', 'doc.md', 'hash', '2026-01-01')").run();
	db.prepare("INSERT INTO chunks VALUES ('doc', 0, 'quasar', 1, 1, NULL)").run();
	let calls = 0;
	const provider: EmbeddingProvider = {
		identity: "test/executor:v1",
		dimensions: 2,
		async embedDocuments() { return [[1, 0]]; },
		async embedQuery() {
			calls++;
			db.prepare("UPDATE chunks SET content = 'changed'").run();
			return [1, 0];
		},
	};
	const index = new VectorIndex(db, provider);
	await index.syncEmbeddings("document");
	await assert.rejects(new VectorRetriever(index, provider, "document").retrieve({ query: "quasar", topK: 1 }), /incomplete/);
	assert.equal(calls, 1);
});

it("retains private in-memory database retrieval on its owner connection", async () => {
	const memory = openDatabase(":memory:");
	try {
		memory.prepare("INSERT INTO sessions VALUES ('one', 'one.jsonl', 'project')").run();
		memory.prepare("INSERT INTO summaries VALUES ('one', 'entry', 'quasar', '2026-01-01')").run();
		assert.equal((await new BM25Retriever(memory, "memory").retrieve({ query: "quasar", topK: 1 }))[0].sourceId, "one");
		await memory.executor.execute({ sql: "SELECT vec_distance_cosine(?, ?) AS distance", parameters: [new Float32Array([1, 0]), new Float32Array([1, 0])], vector: true });
	} finally { await memory.close(); }
});
