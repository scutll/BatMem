import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { EmbeddingQueryProcessor } from "../../../src/retrieval/processors/rrf-rerank-blend.ts";
import { ParallelRecall as TaskRecall } from "../../../src/retrieval/recall/parallel.ts";
import type { QueryProcessor } from "../../../src/retrieval/core/processor.ts";
import { Retriever } from "../../../src/retrieval/core/retriever.ts";
import { BM25_RECALL, BM25_EMBEDDING_RRF_RERANK_OPTIONS, EMBEDDING_RECALL } from "../../../src/retrieval/strategies/presets.ts";
import type { RetrievalHit, RetrievalQuery, RecallSource } from "../../../src/retrieval/core/types.ts";
import { OfflineReranker } from "../../helpers/reranking.ts";

function hit(sourceId: string, score = 0.75): RetrievalHit {
	return { text: sourceId, score, sourceType: "memory", sourceId, location: { sourcePath: `${sourceId}.jsonl` } };
}

const request = { query: "original", topK: 2 };

it("starts every path before completion and processes all results in registration order", async () => {
	const started: string[] = [];
	const gates = Array.from({ length: 3 }, () => Promise.withResolvers<RetrievalHit[]>());
	const recall = new TaskRecall(
		gates.map((gate, index) => ({
			path: `path-${index}`,
			run: async () => {
				started.push(`path-${index}`);
				return gate.promise;
			},
		})),
	);
	const processor = {
		process: mock.fn(async (_request: RetrievalQuery, results: { path: string; hits: RetrievalHit[] }[]) =>
			results.flatMap((result) => result.hits),
		),
	} satisfies QueryProcessor;
	const service = new Retriever<RetrievalHit>({ sourceType: "memory", bm25: { retrieve: async () => [] } });
	const selected = { id: "test", createRecall: () => recall, createProcessor: () => processor };
	const pending = service.retrieve(request, selected);
	assert.deepEqual(started, ["path-0", "path-1", "path-2"]);
	gates[2].resolve([hit("third")]);
	gates[0].resolve([hit("first")]);
	await gates[0].promise;
	assert.equal(processor.process.mock.callCount(), 0);
	gates[1].resolve([]);
	assert.deepEqual(
		(await pending).map((result) => result.sourceId),
		["first", "third"],
	);
	assert.deepEqual(processor.process.mock.calls[0].arguments, [
		request,
		[
			{ path: "path-0", hits: [hit("first")] },
			{ path: "path-1", hits: [] },
			{ path: "path-2", hits: [hit("third")] },
		],
	]);
});

it("drains other paths after synchronous and async failures without invoking the processor", async () => {
	const gate = Promise.withResolvers<RetrievalHit[]>();
	const failed = Promise.withResolvers<void>();
	const cause = new Error("sync failure");
	const recall = new TaskRecall([
		{
			path: "sync",
			run: () => {
				throw cause;
			},
		},
		{
			path: "async",
			run: async () => {
				failed.resolve();
				throw new Error("async failure");
			},
		},
		{ path: "slow", run: async () => gate.promise },
	]);
	const processor = { process: mock.fn(async () => []) } satisfies QueryProcessor;
	const service = new Retriever<RetrievalHit>({ sourceType: "memory", bm25: { retrieve: async () => [] } });
	const selected = { id: "test", createRecall: () => recall, createProcessor: () => processor };
	let finished = false;
	const checked = assert.rejects(
		service.retrieve(request, selected).finally(() => {
			finished = true;
		}),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /sync.*sync failure.*async.*async failure/);
			assert.equal(error.errors[0].cause, cause);
			return true;
		},
	);
	await failed.promise;
	assert.equal(finished, false);
	gate.resolve([]);
	await checked;
	assert.equal(processor.process.mock.callCount(), 0);
});

it("isolates rewritten requests and concurrent results while allowing path-specific postprocessing", async () => {
	const seen: RetrievalQuery[] = [];
	const recall = new TaskRecall([
		{
			path: "rewrite",
			run: async (input) => {
				input.query += " rewritten";
				input.topK = 1;
				return [hit(input.query)].map((result) => ({ ...result, score: 1 }));
			},
		},
		{
			path: "original",
			run: async (input) => {
				seen.push(input);
				return [hit(input.query)];
			},
		},
	]);
	const [first, second] = await Promise.all([recall.recall(request), recall.recall({ query: "second", topK: 3 })]);
	assert.deepEqual(seen, [request, { query: "second", topK: 3 }]);
	assert.equal(request.query, "original");
	assert.equal(request.topK, 2);
	assert.equal(first[0].hits[0].text, "original rewritten");
	assert.equal(second[0].hits[0].text, "second rewritten");
	assert.equal(first[0].hits[0].score, 1);
});

it("rejects empty or duplicate path names and an empty combination", async () => {
	const run = async () => [];
	assert.throws(() => new TaskRecall([{ path: " ", run }]), /nonempty/);
	assert.throws(
		() =>
			new TaskRecall([
				{ path: "same", run },
				{ path: "same", run },
			]),
		/unique/,
	);
	await assert.rejects(new TaskRecall([]).recall(request), /No recall paths/);
});

it("deduplicates each path, sums cross-path contributions and applies the best-rank bonus once", async () => {
	const reranker = new OfflineReranker();
	const processor = new EmbeddingQueryProcessor(reranker);
	assert.equal(processor.reranker, reranker);
	const first = { ...hit("a", -100), extra: "preserved" };
	const results = [
		{ path: "bm25", hits: [first, { ...first, score: 999 }, hit("b"), hit("c"), hit("d")] },
		{ path: "embedding", hits: [hit("c"), hit("b"), hit("a"), hit("d")] },
	];
	const before = structuredClone(results);
	const fused = await processor.process({ query: "q", topK: 10 }, results);
	assert.deepEqual(
		fused.map((result) => result.sourceId),
		["a", "c", "b", "d"],
	);
	assert.deepEqual(
		fused.map((result) => result.score),
		[0.75, 0.375, 0.25, 0.15],
	);
	assert.deepEqual(fused[0], { ...first, score: 0.75 });
	assert.deepEqual(results, before);
	assert.notEqual(fused[0], first);
	assert.deepEqual(reranker.calls[0], { query: "q", hits: [first, hit("c"), hit("b"), hit("d")], topK: 4 });
	assert.deepEqual(await processor.process({ query: "q", topK: 1 }, results), [fused[0]]);
});

it("uses source identity instead of text and keeps document chunks separate", async () => {
	const reranker = new OfflineReranker();
	const processor = new EmbeddingQueryProcessor(reranker);
	const memory = { ...hit("same"), text: "identical" };
	const chunk0: RetrievalHit = {
		...memory,
		sourceType: "document",
		location: { sourcePath: "same.md", chunkIndex: 0, startLine: 1 },
	};
	const chunk1: RetrievalHit = { ...chunk0, location: { sourcePath: "same.md", chunkIndex: 1, startLine: 5 } };
	const results = await processor.process({ query: "q", topK: 10 }, [
		{ path: "bm25", hits: [memory, chunk0, chunk1] },
		{ path: "embedding", hits: [chunk1, chunk0] },
	]);
	assert.deepEqual(results, [
		{ ...chunk1, score: 0.75 },
		{ ...memory, score: 0.375 },
		{ ...chunk0, score: 0.25 },
	]);
});

it("handles empty paths, invalid limits, custom RRF k and topK above 40", async () => {
	const reranker = new OfflineReranker();
	const processor = new EmbeddingQueryProcessor(reranker, 0);
	assert.deepEqual(await processor.process(request, []), []);
	assert.deepEqual(await processor.process(request, [{ path: "embedding", hits: [] }]), []);
	const results = [{ path: "bm25", hits: Array.from({ length: 50 }, (_, index) => hit(String(index))) }];
	for (const topK of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
		assert.deepEqual(await processor.process({ query: "q", topK }, results), []);
	assert.equal(reranker.calls.length, 0);
	const fused = await processor.process({ query: "q", topK: 45 }, results);
	assert.equal(fused.length, 45);
	assert.equal(fused[0].score, 0.75);
	assert.equal(fused[1].score, 0.375);
	assert.equal(fused[44].score, 0.4 / 45);
	assert.equal(reranker.calls[0].hits.length, 45);
	assert.equal(reranker.calls[0].topK, 45);
	await processor.process({ query: "q", topK: 2 }, results);
	assert.equal(reranker.calls[1].hits.length, 40);
	assert.equal(reranker.calls[1].topK, 40);
	for (const k of [-1, 1.5, NaN, Infinity]) assert.throws(() => new EmbeddingQueryProcessor(reranker, k), /rrfK/);
});

it("blends by RRF rank at the 3/4 and 10/11 boundaries despite reordered model results", async () => {
	const reranker = new OfflineReranker([0, 0, 0.8, 0.9, 0, 0, 0, 0, 0, 0.6, 0.7]);
	const processor = new EmbeddingQueryProcessor(reranker);
	const hits = Array.from({ length: 11 }, (_, index) => hit(String(index + 1)));
	const output = await processor.process({ query: "q", topK: 11 }, [{ path: "embedding", hits }]);
	const scores = new Map(output.map((result) => [result.sourceId, result.score]));
	assert.ok(Math.abs((scores.get("3") ?? NaN) - 0.45) < 1e-12);
	assert.ok(Math.abs((scores.get("4") ?? NaN) - 0.51) < 1e-12);
	assert.ok(Math.abs((scores.get("10") ?? NaN) - 0.3) < 1e-12);
	assert.ok(Math.abs((scores.get("11") ?? NaN) - (0.4 / 11 + 0.42)) < 1e-12);
	assert.deepEqual(
		output.slice(0, 5).map((result) => result.sourceId),
		["1", "4", "11", "3", "2"],
	);
});

it("scores every candidate before selecting topK and propagates reranker failure", async () => {
	const reranker = new OfflineReranker([0, 0, 0, 1]);
	const processor = new EmbeddingQueryProcessor(reranker);
	const hits = [hit("a"), hit("b"), hit("c"), hit("d")];
	assert.deepEqual(await processor.process({ query: "q", topK: 1 }, [{ path: "embedding", hits }]), [
		{ ...hits[0], score: 0.75 },
	]);
	assert.equal(reranker.calls[0].topK, 4);
	assert.deepEqual(reranker.calls[0].hits, hits);
	const cause = new Error("reranker failed");
	mock.method(reranker, "rerank", async () => {
		throw cause;
	});
	await assert.rejects(processor.process(request, [{ path: "embedding", hits }]), (error: unknown) => error === cause);
});

it("query recalls both paths once while search and vsearch keep their single-path behavior", async () => {
	const lexical = { retrieve: mock.fn(async () => [hit("lexical", 10)]) } satisfies RecallSource;
	const hits = [hit("semantic")];
	const vector = { retrieve: mock.fn(async () => hits) } satisfies RecallSource;
	const reranker = new OfflineReranker();
	const service = new Retriever({ sourceType: "memory", bm25: lexical, vector, reranker });
	const selected = BM25_EMBEDDING_RRF_RERANK_OPTIONS;
	assert.deepEqual(await service.retrieve(request, selected), [
		{ ...hit("lexical", 10), score: 0.75 },
		{ ...hits[0], score: 0.375 },
	]);
	assert.equal(lexical.retrieve.mock.callCount(), 1);
	assert.equal(vector.retrieve.mock.callCount(), 1);
	assert.equal(reranker.calls.length, 1);
	await service.retrieve(request, BM25_RECALL);
	assert.equal(vector.retrieve.mock.callCount(), 1);
	await service.retrieve(request, EMBEDDING_RECALL);
	assert.equal(lexical.retrieve.mock.callCount(), 2);
	await assert.rejects(
		new Retriever({ sourceType: "memory", bm25: lexical }).retrieve(request, BM25_EMBEDDING_RRF_RERANK_OPTIONS),
		/requires an embedding provider/,
	);
});

it("propagates processor failure after successful recall", async () => {
	const cause = new Error("processor failed");
	const service = new Retriever({ sourceType: "memory", bm25: { retrieve: async () => [] } });
	const selected = {
		id: "failure",
		createRecall: () => new TaskRecall([{ path: "custom", run: async () => [] }]),
		createProcessor: () => ({
			process: async () => {
				throw cause;
			},
		}),
	};
	await assert.rejects(service.retrieve(request, selected), (error: unknown) => error === cause);
});
