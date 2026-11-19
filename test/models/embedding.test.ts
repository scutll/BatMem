import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JinaEmbeddingProvider } from "../../src/models/embedding/jina.ts";

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: unknown;
}

describe("Jina embedding provider", () => {
	it("uses distinct document and query tasks and restores response order", async () => {
		const requests: CapturedRequest[] = [];
		const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as unknown,
			});
			const body = requests.at(-1)?.body as { input: string[] };
			return Response.json({
				data: body.input
					.map((_text, index) => ({ index, embedding: [index + 1, index + 1] }))
					.reverse(),
				model: "jina-embeddings-v3",
			});
		};
		const provider = new JinaEmbeddingProvider({ apiKey: "test-secret", dimensions: 2, fetch: request });

		const documents = await provider.embedDocuments(["first", "second"]);
		assert.deepEqual(documents, [[1, 1], [2, 2]]);
		const query = await provider.embedQuery("question");
		assert.deepEqual(query, [1, 1]);
		assert.equal(requests.length, 2);
		assert.equal(requests[0].url, "https://api.jina.ai/v1/embeddings");
		assert.equal(requests[0].headers.get("authorization"), "Bearer test-secret");
		assert.deepEqual(requests[0].body, {
			model: "jina-embeddings-v3",
			input: ["first", "second"],
			task: "retrieval.passage",
			dimensions: 2,
			embedding_type: "float",
			normalized: true,
			late_chunking: false,
			truncate: false,
		});
		assert.deepEqual(requests[1].body, {
			model: "jina-embeddings-v3",
			input: ["question"],
			task: "retrieval.query",
			dimensions: 2,
			embedding_type: "float",
			normalized: true,
			late_chunking: false,
			truncate: false,
		});
	});

	const validVector = [1, 1];
	for (const [name, data, pattern] of [
		["missing item", [{ index: 0, embedding: validVector }], /count/i],
		[
			"duplicate index",
			[
				{ index: 0, embedding: validVector },
				{ index: 0, embedding: validVector },
			],
			/index/i,
		],
		[
			"out-of-range index",
			[
				{ index: 0, embedding: validVector },
				{ index: 2, embedding: validVector },
			],
			/index/i,
		],
		[
			"wrong dimension",
			[
				{ index: 0, embedding: validVector },
				{ index: 1, embedding: [3] },
			],
			/dimension/i,
		],
		[
			"non-finite value",
			[
				{ index: 0, embedding: validVector },
				{ index: 1, embedding: [1, "NaN"] },
			],
			/finite|number|values/i,
		],
	] as const) {
		it(`rejects a ${name} response`, async () => {
			const provider = new JinaEmbeddingProvider({
				apiKey: "test-secret",
				dimensions: 2,
				fetch: async () => Response.json({ data, model: "jina-embeddings-v3" }),
			});
			await assert.rejects(provider.embedDocuments(["first", "second"]), pattern);
		});
	}

	it("reports non-retryable HTTP failures without exposing the API key", async () => {
		let calls = 0;
		const provider = new JinaEmbeddingProvider({
			apiKey: "secret-that-must-not-leak",
			dimensions: 2,
			fetch: async () => {
				calls += 1;
				return new Response("invalid request", { status: 400 });
			},
		});
		await assert.rejects(
			provider.embedQuery("question"),
			(error: unknown) =>
					error instanceof Error && /400/.test(error.message) && !error.message.includes("secret-that-must-not-leak"),
		);
		assert.equal(calls, 1);
	});

	it("rejects invalid JSON and empty document batches", async () => {
		let calls = 0;
		const provider = new JinaEmbeddingProvider({
			apiKey: "test-secret",
			dimensions: 2,
			fetch: async () => {
				calls += 1;
				return new Response("not-json", { status: 200 });
			},
		});
		assert.deepEqual(await provider.embedDocuments([]), []);
		assert.equal(calls, 0);
		await assert.rejects(provider.embedQuery("question"), /JSON/i);
		assert.equal(calls, 1);
	});
});
