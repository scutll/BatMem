import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openDatabase } from "../../src/storage/database.ts";
import type { EmbeddingProvider } from "../../src/models/embedding/provider.ts";
import type { RetrievalHit } from "../../src/retrieval/core/types.ts";
import { VectorIndex } from "../../src/storage/vector-index.ts";

const identity = "test/fixed-2d:retrieval.passage/retrieval.query:v1";

describe("vector index", () => {
	let directory: string;
	let db: DatabaseSync;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "batmem-vector-"));
		db = openDatabase(join(directory, "index.db"));
	});

	afterEach(async () => {
		db?.close();
		await rm(directory, { recursive: true, force: true });
	});

	function insertDocument(id: string, content: string, chunkIndex = 0): void {
		db.prepare("INSERT OR IGNORE INTO documents VALUES (?, ?, ?, ?)").run(
			id,
			join(directory, `${id}.md`),
			`hash-${id}`,
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run(id, chunkIndex, content, 1, 1, null);
	}

	function createProvider(vectors: ReadonlyMap<string, readonly number[]>): EmbeddingProvider {
		return {
			identity,
			dimensions: 2,
			async embedDocuments(texts: readonly string[]) {
				return texts.map((text) => {
					const vector = vectors.get(text);
					if (!vector) throw new Error(`Missing fixed vector for ${text}`);
					return [...vector];
				});
			},
			async embedQuery() {
				return [1, 0];
			},
		};
	}

	it("uses sqlite-vec cosine ranking and preserves document chunk identities", async () => {
		insertDocument("same", "parallel", 0);
		insertDocument("orthogonal", "orthogonal");
		insertDocument("opposite", "opposite");
		db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run("same", 1, "parallel-two", 2, 2, null);
		const provider = createProvider(
			new Map([
				["parallel", [1, 0]],
				["parallel-two", [1, 0]],
				["orthogonal", [0, 1]],
				["opposite", [-1, 0]],
			]),
		);
		const index = new VectorIndex(db, provider, 2);
		index.initialize();
		await index.syncEmbeddings("document");

		assert.deepEqual(index.getStatus("document"), { total: 4, indexed: 4, pending: 0 });
		const hits = index.search("document", [1, 0], 4);
		assert.deepEqual(
			hits.map((hit: RetrievalHit) => [hit.sourceId, hit.location.chunkIndex]),
			[
				["same", 0],
				["same", 1],
				["orthogonal", 0],
				["opposite", 0],
			],
		);
		assert.ok(hits.every((hit: RetrievalHit, index: number) => index === 0 || hits[index - 1].score >= hit.score));
		assert.ok(hits.every((hit: RetrievalHit) => hit.sourceType === "document" && hit.location.sourcePath.endsWith(".md")));
	});

	it("indexes current summaries and returns their raw-read coordinates", async () => {
		db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
			"session-a",
			join(directory, "session-a.jsonl"),
			directory,
		);
		db.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?)").run(
			"session-a",
			"entry-2",
			"summary text",
			"2026-01-01T00:00:02.000Z",
		);
		const index = new VectorIndex(db, createProvider(new Map([["summary text", [1, 0]]])));
		index.initialize();
		await index.syncEmbeddings("memory");

		const [hit] = index.search("memory", [1, 0], 1);
		assert.equal(hit.sourceId, "session-a");
		assert.equal(hit.text, "summary text");
		assert.deepEqual(hit.location, {
			sourcePath: join(directory, "session-a.jsonl"),
			entryId: "entry-2",
			timestamp: "2026-01-01T00:00:02.000Z",
		});
	});

	it("retains completed batches and resumes only missing embeddings", async () => {
		insertDocument("one", "one");
		insertDocument("two", "two");
		insertDocument("three", "three");
		let firstCalls = 0;
		const failing: EmbeddingProvider = {
			identity,
			dimensions: 2,
			async embedDocuments(texts: readonly string[]) {
				firstCalls += 1;
				if (firstCalls === 2) throw new Error("batch failed");
				return texts.map((text) => (text === "one" ? [1, 0] : [0, 1]));
			},
			async embedQuery() {
				return [1, 0];
			},
		};
		const interrupted = new VectorIndex(db, failing, 2);
		interrupted.initialize();
		await assert.rejects(interrupted.syncEmbeddings("document"), /batch failed/);
		assert.deepEqual(interrupted.getStatus("document"), { total: 3, indexed: 2, pending: 1 });

		const resumedInputs: string[][] = [];
		const resumed: EmbeddingProvider = {
			identity,
			dimensions: 2,
			async embedDocuments(texts: readonly string[]) {
				resumedInputs.push([...texts]);
				return texts.map(() => [-1, 0]);
			},
			async embedQuery() {
				return [1, 0];
			},
		};
		const recovered = new VectorIndex(db, resumed, 2);
		recovered.initialize();
		await recovered.syncEmbeddings("document");
		assert.deepEqual(resumedInputs, [["three"]]);
		assert.deepEqual(recovered.getStatus("document"), { total: 3, indexed: 3, pending: 0 });
	});

	it("invalidates changed and deleted chunks while retaining unchanged vectors", async () => {
		insertDocument("one", "old");
		insertDocument("two", "stable");
		const initial = new VectorIndex(
			db,
			createProvider(
				new Map([
					["old", [1, 0]],
					["stable", [0, 1]],
				]),
			),
		);
		initial.initialize();
		await initial.syncEmbeddings("document");

		db.prepare("UPDATE chunks SET content = ? WHERE document_id = ?").run("new", "one");
		db.prepare("DELETE FROM documents WHERE id = ?").run("two");
		const inputs: string[][] = [];
		const updated: EmbeddingProvider = {
			identity,
			dimensions: 2,
			async embedDocuments(texts: readonly string[]) {
				inputs.push([...texts]);
				return texts.map(() => [-1, 0]);
			},
			async embedQuery() {
				return [1, 0];
			},
		};
		const index = new VectorIndex(db, updated);
		index.initialize();
		await index.syncEmbeddings("document");
		assert.deepEqual(inputs, [["new"]]);
		const hits = index.search("document", [1, 0], 10);
		assert.deepEqual(hits.map((hit: RetrievalHit) => [hit.sourceId, hit.text]), [["one", "new"]]);
	});

	it("discards an embedding response when its source changes before writeback", async () => {
		insertDocument("one", "old");
		let release: ((vectors: number[][]) => void) | undefined;
		let markStarted: (() => void) | undefined;
		let calls = 0;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const response = new Promise<number[][]>((resolve) => {
			release = resolve;
		});
		const provider: EmbeddingProvider = {
			identity,
			dimensions: 2,
			async embedDocuments() {
				calls += 1;
				if (calls > 1) throw new Error("stale response was retried automatically");
				markStarted?.();
				return response;
			},
			async embedQuery() {
				return [1, 0];
			},
		};
		const index = new VectorIndex(db, provider);
		index.initialize();
		const syncing = index.syncEmbeddings("document");
		await started;
		db.prepare("UPDATE chunks SET content = ? WHERE document_id = ?").run("new", "one");
		release?.([[1, 0]]);
		await syncing;

		assert.equal(calls, 1);
		assert.deepEqual(index.getStatus("document"), { total: 1, indexed: 0, pending: 1 });
		assert.throws(() => index.search("document", [1, 0], 10), /incomplete/i);
	});

	it("rejects incompatible vector spaces and persists compatible vectors after reopen", async () => {
		insertDocument("one", "one");
		const provider = createProvider(new Map([["one", [1, 0]]]));
		let index = new VectorIndex(db, provider);
		index.initialize();
		await index.syncEmbeddings("document");
		db.close();
		db = openDatabase(join(directory, "index.db"));
		index = new VectorIndex(db, provider);
		index.initialize();
		assert.deepEqual(index.getStatus("document"), { total: 1, indexed: 1, pending: 0 });
		assert.equal(index.search("document", [1, 0], 1)[0].sourceId, "one");

		const incompatible: EmbeddingProvider = {
			...provider,
			identity: "test/different-model:2d:v1",
		};
		const otherSpace = new VectorIndex(db, incompatible);
		assert.throws(() => otherSpace.initialize(), /differs|rebuild/i);
	});
});
