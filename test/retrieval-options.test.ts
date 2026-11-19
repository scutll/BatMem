import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { ParallelRecall } from "../src/search/parallel-recall.ts";
import { PassthroughProcessor } from "../src/search/passthrough-processor.ts";
import { SearchService } from "../src/search/service.ts";
import { BM25_RECALL, selectRetrievalOptions } from "../src/search/strategies.ts";
import type { RetrievalHit, RetrievalOptions } from "../src/search/types.ts";

function hit(text: string): RetrievalHit {
	return { text, score: 1, sourceId: text, sourceType: "memory", location: { sourcePath: "history.jsonl" } };
}

it("keeps expansion in run and gives the processor the original query", async () => {
	const expand = mock.fn(async (query: string) => `${query} expanded`);
	const retrieve = mock.fn(async ({ query }: { query: string }) => [hit(query), hit("extra")]);
	const service = new SearchService({ sourceType: "memory", bm25: { retrieve } });
	let factories = 0;
	const selected: RetrievalOptions = {
		id: "expanded-lexical",
		createRecall: ({ bm25, sourceType }) => {
			assert.equal(sourceType, "memory");
			factories++;
			return new ParallelRecall([
				{
					path: "expanded",
					run: async (request) => bm25.retrieve({ ...request, query: await expand(request.query), topK: 20 }),
				},
			]);
		},
		createProcessor: () => ({
			async process(request, results) {
				assert.equal(request.query, "question");
				assert.equal(request.topK, 1);
				return results[0].hits;
			},
		}),
	};
	const request = { query: "question", topK: 1 };
	assert.deepEqual(await service.retrieve(request, selected), [hit("question expanded")]);
	assert.deepEqual(await service.retrieve(request, BM25_RECALL), [hit("question")]);
	assert.deepEqual(await service.retrieve(request, selected), [hit("question expanded")]);
	assert.equal(factories, 2);
	assert.equal(expand.mock.callCount(), 2);
	assert.deepEqual(retrieve.mock.calls[0].arguments[0], { query: "question expanded", topK: 20 });
	assert.deepEqual(request, { query: "question", topK: 1 });
});

it("snapshots both factories and isolates state when switching during an unfinished request", async () => {
	const gate = Promise.withResolvers<void>();
	const service = new SearchService({ sourceType: "memory", bm25: { retrieve: async () => [hit("new")] } });
	const usedInstances: number[] = [];
	let instances = 0;
	let active: RetrievalOptions = {
		id: "slow",
		createRecall: () => {
			const instance = ++instances;
			return new ParallelRecall([
				{
					path: "slow",
					run: async () => {
						await gate.promise;
						usedInstances.push(instance);
						return [hit("old")];
					},
				},
			]);
		},
		createProcessor: () => ({
			async process(_request, results) {
				return results[0].hits.map((result) => ({ ...result, score: 42 }));
			},
		}),
	};
	const first = service.retrieve({ query: "q", topK: 1 }, active);
	const second = service.retrieve({ query: "q", topK: 1 }, active);
	active = BM25_RECALL;
	assert.deepEqual(await service.retrieve({ query: "q", topK: 1 }, active), [hit("new")]);
	gate.resolve();
	assert.deepEqual(await first, [{ ...hit("old"), score: 42 }]);
	assert.deepEqual(await second, [{ ...hit("old"), score: 42 }]);
	assert.deepEqual(usedInstances, [1, 2]);
});

it("accepts structural recall implementations and keeps processor input isolated from recall mutations", async () => {
	const service = new SearchService({ sourceType: "memory", bm25: { retrieve: async () => [hit("unused")] } });
	const selected: RetrievalOptions = {
		id: "structural",
		createRecall: () => ({
			async recall(request) {
				request.query = "rewritten";
				request.topK = 99;
				return [{ path: "custom", hits: [hit(request.query)] }];
			},
		}),
		createProcessor: () => ({
			async process(request, results) {
				assert.deepEqual(request, { query: "original", topK: 1 });
				return results[0].hits;
			},
		}),
	};
	assert.deepEqual(await service.retrieve({ query: "original", topK: 1 }, selected), [hit("rewritten")]);
});

it("validates strategy names and rejects ambiguous passthrough configurations", async () => {
	assert.equal(selectRetrievalOptions("search"), BM25_RECALL);
	for (const name of ["unknown", "toString", "constructor"])
		assert.throws(() => selectRetrievalOptions(name), /Unknown retrieval strategy/);
	const processor = new PassthroughProcessor();
	const request = { query: "q", topK: 1 };
	await assert.rejects(processor.process(request, []), /exactly one/);
	await assert.rejects(
		processor.process(request, [
			{ path: "a", hits: [] },
			{ path: "b", hits: [] },
		]),
		/exactly one/,
	);
	assert.deepEqual(await processor.process(request, [{ path: "a", hits: [] }]), []);
});
