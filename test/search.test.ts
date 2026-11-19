import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { EmbeddingProvider } from "../src/embedding/provider.ts";
import { VectorIndex } from "../src/embedding/vector-index.ts";
import { BM25Retriever } from "../src/search/bm25.ts";
import { SearchService } from "../src/search/service.ts";
import { BM25_RECALL, BM25_EMBEDDING_RRF_RERANK_OPTIONS, EMBEDDING_RECALL } from "../src/search/strategies.ts";
import type { RetrievalHit, Retriever } from "../src/search/types.ts";
import { VectorRetriever } from "../src/search/vector.ts";
import { openDatabase } from "../src/storage/db.ts";
import { OfflineReranker } from "./helpers/reranking.ts";

function createSearchService(bm25: Retriever, vector: Retriever): SearchService {
	return new SearchService({ sourceType: "memory", bm25, vector, reranker: new OfflineReranker() });
}

function hit(sourceId: string, score: number): RetrievalHit {
	return {
		text: sourceId,
		score,
		sourceType: "memory",
		sourceId,
		location: { sourcePath: `${sourceId}.jsonl`, entryId: "entry" },
	};
}

describe("search services", () => {
	let directory: string;
	let db: DatabaseSync;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "batmem-search-"));
		db = openDatabase(join(directory, "index.db"));
	});

	afterEach(async () => {
		db?.close();
		await rm(directory, { recursive: true, force: true });
	});

	it("returns memory BM25 scores in descending relevance order", async () => {
		for (const [sessionId, summary] of [
			["short", "quasar"],
			["long", "quasar orbital deployment background"],
		] as const) {
			db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(sessionId, `${sessionId}.jsonl`, directory);
			db.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?)").run(
				sessionId,
				"entry",
				summary,
				"2026-01-01T00:00:00.000Z",
			);
		}
		const retriever = new BM25Retriever(db, "memory");
		const hits = await retriever.retrieve({ query: "quasar", topK: 2 });
		assert.deepEqual(
			hits.map((result) => result.sourceId),
			["short", "long"],
		);
		assert.ok(hits[0].score >= hits[1].score);
		assert.ok(hits.every((result) => result.score >= 0 && Number.isFinite(result.score)));
		assert.deepEqual(await retriever.retrieve({ query: "   ", topK: 2 }), []);
		assert.deepEqual(await retriever.retrieve({ query: "quasar", topK: 0 }), []);
		await assert.doesNotReject(retriever.retrieve({ query: 'quasar " OR (', topK: 2 }));
	});

	it("returns document coordinates without merging chunks from one document", async () => {
		db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(
			"document",
			join(directory, "document.md"),
			"hash",
			"2026-01-01T00:00:00.000Z",
		);
		for (const [chunkIndex, content] of [
			[0, "quasar first"],
			[1, "quasar second"],
		] as const)
			db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run(
				"document",
				chunkIndex,
				content,
				chunkIndex + 1,
				chunkIndex + 1,
				"Section",
			);
		const hits = await new BM25Retriever(db, "document").retrieve({ query: "quasar", topK: 10 });
		assert.deepEqual(
			hits.map((result) => result.location.chunkIndex),
			[0, 1],
		);
		assert.ok(hits.every((result) => result.sourceId === "document" && result.sourceType === "document"));
	});

	it("routes search and vsearch to separate retrievers", async () => {
		const lexicalHits = [hit("lexical", 2)];
		const vectorHits = [hit("semantic", 0.9)];
		const lexical = {
			retrieve: mock.fn(async (_request: { query: string; topK: number }) => lexicalHits),
		} satisfies Retriever;
		const vector = {
			retrieve: mock.fn(async (_request: { query: string; topK: number }) => vectorHits),
		} satisfies Retriever;
		const service = createSearchService(lexical, vector);
		const request = { query: "question", topK: 5 };

		assert.deepEqual(await service.retrieve(request, BM25_RECALL), lexicalHits);
		assert.deepEqual(await service.retrieve(request, EMBEDDING_RECALL), vectorHits);
		assert.equal(lexical.retrieve.mock.callCount(), 1);
		assert.equal(vector.retrieve.mock.callCount(), 1);
		assert.deepEqual(lexical.retrieve.mock.calls[0].arguments[0], request);
		assert.deepEqual(vector.retrieve.mock.calls[0].arguments[0], request);
	});

	it("encodes a vector query once and returns source-preserving hits", async () => {
		db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(
			"document",
			join(directory, "document.md"),
			"hash",
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run("document", 0, "semantic text", 1, 1, null);
		const queries: string[] = [];
		const provider: EmbeddingProvider = {
			identity: "test/fixed-2d:v1",
			dimensions: 2,
			async embedDocuments() {
				return [[1, 0]];
			},
			async embedQuery(query) {
				queries.push(query);
				return [1, 0];
			},
		};
		const index = new VectorIndex(db, provider);
		index.initialize();
		await index.syncEmbeddings("document");
		const hits = await new VectorRetriever(index, provider, "document").retrieve({ query: "meaning", topK: 1 });

		assert.deepEqual(queries, ["meaning"]);
		assert.equal(hits[0].sourceType, "document");
		assert.equal(hits[0].sourceId, "document");
		assert.equal(hits[0].location.chunkIndex, 0);
	});

	it("checks vector readiness before spending a query embedding call", async () => {
		db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(
			"document",
			join(directory, "document.md"),
			"hash",
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run("document", 0, "pending", 1, 1, null);
		let queryCalls = 0;
		const provider: EmbeddingProvider = {
			identity: "test/fixed-2d:v1",
			dimensions: 2,
			async embedDocuments() {
				return [[1, 0]];
			},
			async embedQuery() {
				queryCalls += 1;
				return [1, 0];
			},
		};
		const index = new VectorIndex(db, provider);
		index.initialize();

		await assert.rejects(
			new VectorRetriever(index, provider, "document").retrieve({ query: "meaning", topK: 1 }),
			/incomplete/i,
		);
		assert.equal(queryCalls, 0);
		await assert.rejects(
			createSearchService(new BM25Retriever(db, "document"), new VectorRetriever(index, provider, "document")).retrieve(
				{
					query: "meaning",
					topK: 1,
				},
				BM25_EMBEDDING_RRF_RERANK_OPTIONS,
			),
			/incomplete/i,
		);
		assert.equal(queryCalls, 0);
	});

	it("query fuses BM25 and vector chunk rankings while preserving coordinates", async () => {
		db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run("doc", "doc.md", "hash", "2026-01-01");
		db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run("doc", 0, "quasar", 1, 1, "First");
		db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)").run("doc", 1, "semantic", 2, 2, "Second");
		const queries: string[] = [];
		const provider: EmbeddingProvider = {
			identity: "test/query-2d:v1",
			dimensions: 2,
			async embedDocuments(texts) {
				return texts.map((text) => (text === "semantic" ? [1, 0] : [0, 1]));
			},
			async embedQuery(query) {
				queries.push(query);
				return [1, 0];
			},
		};
		const index = new VectorIndex(db, provider);
		await index.syncEmbeddings("document");
		const service = createSearchService(
			new BM25Retriever(db, "document"),
			new VectorRetriever(index, provider, "document"),
		);
		const request = { query: "quasar", topK: 2 };
		assert.deepEqual(
			(await service.retrieve(request, BM25_RECALL)).map((hit) => hit.location.chunkIndex),
			[0],
		);
		const hits = await service.retrieve(request, BM25_EMBEDDING_RRF_RERANK_OPTIONS);
		const vectorHits = await service.retrieve(request, EMBEDDING_RECALL);
		assert.deepEqual(hits, [
			{ ...vectorHits[1], score: 0.75 },
			{ ...vectorHits[0], score: 0.375 },
		]);
		assert.deepEqual(
			hits.map((hit) => hit.location.chunkIndex),
			[0, 1],
		);
		assert.equal(hits[0].location.startLine, 1);
		assert.equal(hits[0].location.section, "First");
		assert.deepEqual(queries, ["quasar", "quasar"]);
		assert.deepEqual(await service.retrieve({ query: " ", topK: 2 }, BM25_EMBEDDING_RRF_RERANK_OPTIONS), []);
		assert.deepEqual(await service.retrieve({ query: "quasar", topK: 0 }, BM25_EMBEDDING_RRF_RERANK_OPTIONS), []);
		assert.equal(queries.length, 2);
	});

	it("does not silently fall back when vector retrieval fails", async () => {
		const lexical = {
			retrieve: mock.fn(async (_request: { query: string; topK: number }) => [hit("lexical", 2)]),
		} satisfies Retriever;
		const vector: Retriever = {
			async retrieve() {
				throw new Error("vector index is not ready");
			},
		};
		const service = createSearchService(lexical, vector);
		await assert.rejects(service.retrieve({ query: "question", topK: 5 }, EMBEDDING_RECALL), /not ready/);
		assert.equal(lexical.retrieve.mock.callCount(), 0);
	});

	it("supports a BM25-only service while making vsearch unavailability explicit", async () => {
		const lexical = {
			retrieve: mock.fn(async (_request: { query: string; topK: number }) => [hit("lexical", 2)]),
		} satisfies Retriever;
		const service = new SearchService({ sourceType: "memory", bm25: lexical });
		assert.equal((await service.retrieve({ query: "question", topK: 5 }, BM25_RECALL))[0].sourceId, "lexical");
		await assert.rejects(
			service.retrieve({ query: "question", topK: 5 }, EMBEDDING_RECALL),
			/embedding|vector|configured/i,
		);
	});
});
