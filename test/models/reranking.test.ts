import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JinaRerankingProvider } from "../../src/models/reranking/jina.ts";
import type { RerankingProvider } from "../../src/models/reranking/provider.ts";
import type { RetrievalHit } from "../../src/retrieval/core/types.ts";

function createHits(texts: readonly string[]): RetrievalHit[] {
	return texts.map((text, index) => ({
		text,
		score: 100 - index,
		sourceType: index % 2 ? "document" : "memory",
		sourceId: `source-${index}`,
		location: { sourcePath: `source-${index}.md` },
	}));
}

describe("Jina reranking provider", () => {
	it("sends all candidates once and returns sorted scores with original indices", async () => {
		const hits = Object.freeze(createHits(["same", "", "same"]));
		let calls = 0;
		const provider: RerankingProvider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async (input, init) => {
				calls++;
				assert.equal(String(input), "https://api.jina.ai/v1/rerank");
				assert.equal(init?.method, "POST");
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
				assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
				assert.ok(init?.signal instanceof AbortSignal);
				assert.deepEqual(JSON.parse(String(init?.body)), {
					model: "jina-reranker-v3",
					query: "question",
					documents: ["same", "", "same"],
					top_n: 2,
					return_documents: false,
				});
				return Response.json({
					results: [
						{ index: 2, relevance_score: 0.4 },
						{ index: 1, relevance_score: 0.9 },
					],
				});
			},
		});
		assert.deepEqual(await provider.rerank("question", hits, 2), [
			{ index: 1, score: 0.9 },
			{ index: 2, score: 0.4 },
		]);
		assert.equal(calls, 1);
		assert.deepEqual(hits, createHits(["same", "", "same"]));
	});

	it("caps topK to the candidate count and supports closing an injected transport", async () => {
		const provider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async (_input, init) => {
				assert.equal(JSON.parse(String(init?.body)).top_n, 1);
				return Response.json({ results: [{ index: 0, relevance_score: 0.7 }] });
			},
		});
		assert.deepEqual(await provider.rerank("query", createHits(["document"]), 10), [{ index: 0, score: 0.7 }]);
		await provider.close();
	});

	it("does not request empty candidates, invalid limits or a blank query", async () => {
		let calls = 0;
		const provider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async () => {
				calls++;
				return Response.json({});
			},
		});
		assert.deepEqual(await provider.rerank("query", [], 1), []);
		for (const topK of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			assert.deepEqual(await provider.rerank("query", createHits(["doc"]), topK), []);
		await assert.rejects(provider.rerank("  ", createHits(["doc"]), 1), /blank/);
		assert.equal(calls, 0);
		assert.throws(() => new JinaRerankingProvider({ apiKey: " " }), /JINA_API_KEY/);
	});

	for (const [name, results, pattern] of [
		["missing results", undefined, /count/],
		["missing item", [{ index: 0, relevance_score: 0.8 }], /count/],
		[
			"extra item",
			[
				{ index: 0, relevance_score: 1 },
				{ index: 1, relevance_score: 0.8 },
				{ index: 2, relevance_score: 0.7 },
			],
			/count/,
		],
		["null item", [null, { index: 1, relevance_score: 0.8 }], /item/],
		["missing score", [{ index: 0 }, { index: 1, relevance_score: 0.8 }], /item/],
		[
			"duplicate index",
			[
				{ index: 0, relevance_score: 1 },
				{ index: 0, relevance_score: 0.8 },
			],
			/index/,
		],
		[
			"negative index",
			[
				{ index: -1, relevance_score: 1 },
				{ index: 1, relevance_score: 0.8 },
			],
			/index/,
		],
		[
			"fractional index",
			[
				{ index: 0.5, relevance_score: 1 },
				{ index: 1, relevance_score: 0.8 },
			],
			/index/,
		],
		[
			"out-of-range index",
			[
				{ index: 3, relevance_score: 1 },
				{ index: 1, relevance_score: 0.8 },
			],
			/index/,
		],
		[
			"invalid score",
			[
				{ index: 0, relevance_score: "0.9" },
				{ index: 1, relevance_score: 0.8 },
			],
			/finite/,
		],
		[
			"non-finite score",
			[
				{ index: 0, relevance_score: Infinity },
				{ index: 1, relevance_score: 0.8 },
			],
			/finite/,
		],
	] as const) {
		it(`rejects ${name} without retrying`, async () => {
			let calls = 0;
			const provider = new JinaRerankingProvider({
				apiKey: "test-secret",
				fetch: async () => {
					calls++;
					return Response.json({ results });
				},
			});
			await assert.rejects(provider.rerank("query", createHits(["a", "b", "c"]), 2), pattern);
			assert.equal(calls, 1);
		});
	}

	it("retries transient HTTP and transport failures with fresh deadlines", async () => {
		const signals = new Set<AbortSignal>();
		let calls = 0;
		const provider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async (_input, init) => {
				assert.ok(init?.signal);
				signals.add(init.signal);
				calls++;
				if (calls === 1) throw new TypeError("fetch failed");
				if (calls === 2) return new Response("unavailable", { status: 503 });
				if (calls === 3) return new Response("timeout", { status: 408 });
				return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
			},
		});
		assert.deepEqual(await provider.rerank("query", createHits(["doc"]), 1), [{ index: 0, score: 1 }]);
		assert.equal(calls, 4);
		assert.equal(signals.size, 4);
	});

	it("waits 20 seconds before retrying HTTP 429", { timeout: 30_000 }, async () => {
		let calls = 0;
		const started = performance.now();
		const provider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async () => {
				calls++;
				if (calls === 2) assert.ok(performance.now() - started >= 20_000);
				return calls === 1
					? new Response("rate limited", { status: 429 })
					: Response.json({ results: [{ index: 0, relevance_score: 1 }] });
			},
		});
		assert.deepEqual(await provider.rerank("query", createHits(["doc"]), 1), [{ index: 0, score: 1 }]);
		assert.equal(calls, 2);
	});

	it("stops after four attempts and reports only a safe transport error code", async () => {
		let calls = 0;
		const provider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async () => {
				calls++;
				throw new TypeError("sensitive transport details", { cause: { code: "ECONNRESET" } });
			},
		});
		await assert.rejects(
			provider.rerank("query", createHits(["doc"]), 1),
			(error: unknown) =>
				error instanceof Error &&
				/4 attempts.*ECONNRESET/.test(error.message) &&
				!error.message.includes("sensitive"),
		);
		assert.equal(calls, 4);
	});

	for (const status of [400, 401, 403, 422]) {
		it(`does not retry HTTP ${status} or expose response bodies`, async () => {
			let calls = 0;
			const provider = new JinaRerankingProvider({
				apiKey: "test-secret",
				fetch: async () => {
					calls++;
					return new Response("test-secret", { status });
				},
			});
			await assert.rejects(
				provider.rerank("query", createHits(["doc"]), 1),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes(String(status)) &&
					!error.message.includes("test-secret"),
			);
			assert.equal(calls, 1);
		});
	}

	it("does not retry invalid JSON", async () => {
		let calls = 0;
		const provider = new JinaRerankingProvider({
			apiKey: "test-secret",
			fetch: async () => {
				calls++;
				return new Response("not-json");
			},
		});
		await assert.rejects(provider.rerank("query", createHits(["doc"]), 1), SyntaxError);
		assert.equal(calls, 1);
	});
});
