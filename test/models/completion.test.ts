import assert from "node:assert/strict";
import { it } from "node:test";
import { deepseekCompletion } from "../../src/models/completion/deepseek.ts";

it("sends non-streaming completion settings and returns trimmed text", async () => {
	const provider = new deepseekCompletion({
		apiKey: "test-key",
		baseUrl: "https://example.test/v1/",
		model: "test-model",
		system: "Expand the query only.",
		thinking: { type: "disabled" },
		reasoning_effort: "low",
		fetch: async (url, init) => {
			assert.equal(url, "https://example.test/v1/chat/completions");
			assert.equal(init?.method, "POST");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
			assert.ok(init?.signal instanceof AbortSignal);
			assert.deepEqual(JSON.parse(String(init?.body)), {
				model: "test-model",
				messages: [
					{ role: "system", content: "Expand the query only." },
					{ role: "user", content: "query" },
				],
				stream: false,
				thinking: { type: "disabled" },
				reasoning_effort: "low",
			});
			return Response.json({ choices: [{ message: { content: " expanded query \n" } }] });
		},
	});
	assert.equal(await provider.getResponse("query"), "expanded query");
});

it("retries transient failures with fresh deadlines and stops at the configured limit", async () => {
	let calls = 0;
	const signals = new Set<AbortSignal>();
	const provider = new deepseekCompletion({
		apiKey: "test-key",
		maxRetries: 2,
		fetch: async (_url, init) => {
			calls++;
			assert.ok(init?.signal);
			signals.add(init.signal);
			if (calls === 1) throw new TypeError("network failure");
			return new Response("unavailable", { status: 503 });
		},
	});
	await assert.rejects(provider.getResponse("query"), /HTTP 503/);
	assert.equal(calls, 3);
	assert.equal(signals.size, 3);
});

for (const status of [408, 429, 500]) {
	it(`recovers after HTTP ${status}`, async () => {
		let calls = 0;
		const provider = new deepseekCompletion({
			apiKey: "test-key",
			fetch: async () => {
				calls++;
				return calls === 1
					? new Response("retry", { status })
					: Response.json({ choices: [{ message: { content: "expanded" } }] });
			},
		});
		assert.equal(await provider.getResponse("query"), "expanded");
		assert.equal(calls, 2);
	});
}

for (const status of [400, 401, 403, 422]) {
	it(`does not retry HTTP ${status} or include response bodies in errors`, async () => {
		let calls = 0;
		const provider = new deepseekCompletion({
			apiKey: "test-key",
			fetch: async () => {
				calls++;
				return new Response("sensitive error body", { status });
			},
		});
		await assert.rejects(provider.getResponse("query"), (error: unknown) =>
			error instanceof Error && error.message.includes(String(status)) && !error.message.includes("sensitive"),
		);
		assert.equal(calls, 1);
	});
}

for (const value of [
	null,
	{},
	{ choices: [] },
	{ choices: [{ message: { content: null } }] },
	{ choices: [{ message: { content: "  " } }] },
]) {
	it(`rejects malformed or empty completion ${JSON.stringify(value)} without retrying`, async () => {
		let calls = 0;
		const provider = new deepseekCompletion({
			apiKey: "test-key",
			fetch: async () => {
				calls++;
				return Response.json(value);
			},
		});
		await assert.rejects(provider.getResponse("query"), /Invalid|empty/);
		assert.equal(calls, 1);
	});
}

it("validates retry counts, deadlines and explicitly blank credentials", () => {
	assert.throws(() => new deepseekCompletion({ apiKey: " " }), /DEEPSEEK_API_KEY/);
	assert.throws(() => new deepseekCompletion({ apiKey: "key", maxRetries: -1 }), /maxRetries/);
	assert.throws(() => new deepseekCompletion({ apiKey: "key", timeoutMs: 0 }), /timeoutMs/);
});

it("does not retry invalid JSON", async () => {
	let calls = 0;
	const provider = new deepseekCompletion({
		apiKey: "test-key",
		fetch: async () => {
			calls++;
			return new Response("not-json");
		},
	});
	await assert.rejects(provider.getResponse("query"), SyntaxError);
	assert.equal(calls, 1);
});

it("aborts timed-out requests and stops retrying", async () => {
	let calls = 0;
	const provider = new deepseekCompletion({
		apiKey: "test-key",
		timeoutMs: 5,
		maxRetries: 1,
		fetch: async (_url, init) => {
			calls++;
			const signal = init?.signal;
			assert.ok(signal);
			return new Promise<Response>((_resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Request did not abort.")), 1_000);
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(signal.reason);
				}, { once: true });
			});
		},
	});
	await assert.rejects(provider.getResponse("query"), /transport failed/);
	assert.equal(calls, 2);
});
