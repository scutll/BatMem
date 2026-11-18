import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as embeddingFetch, ProxyAgent } from "undici";
import type { EmbeddingProvider } from "./provider.ts";
import type { JinaEmbeddingOptions } from "./types.ts";

/** Jina v3 HTTP adapter. 10-second attempts, up to three retries, and a 20-second pause after HTTP 429. */
export class JinaEmbeddingProvider implements EmbeddingProvider {
	readonly dimensions: number;
	readonly identity: string;
	private readonly apiKey: string;
	private readonly dispatcher?: Agent | ProxyAgent;
	private readonly request: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
	) => Promise<Pick<Response, "ok" | "status" | "json"> & { body?: { cancel(): Promise<void> } | null }>;

	constructor(options: JinaEmbeddingOptions) {
		if (!options.apiKey.trim()) throw new Error("JINA_API_KEY is required for vector search.");
		if (options.model && options.model !== "jina-embeddings-v3")
			throw new Error("Only jina-embeddings-v3 is supported.");
		this.apiKey = options.apiKey;
		this.dimensions = options.dimensions ?? 1024;
		if (!Number.isSafeInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > 1024)
			throw new Error("Jina v3 dimensions must be between 1 and 1024.");
		this.identity = `jina.ai/jina-embeddings-v3:${this.dimensions}:retrieval.passage/retrieval.query:normalized:truncate=false:v1`;
		// Keep fetch and its dispatcher on the same undici version. Explicit direct mode ignores host proxies.
		this.dispatcher = options.fetch ? undefined : options.proxyUrl ? new ProxyAgent(options.proxyUrl) : new Agent();
		this.request = options.fetch ?? ((url, init) => embeddingFetch(url, { ...init, dispatcher: this.dispatcher }));
	}

	/** Release owned HTTP connections after pending indexing/search calls finish. */
	async close(): Promise<void> {
		await this.dispatcher?.close();
	}

	/** Encode independent retrieval units without changing their boundaries. */
	embedDocuments(texts: readonly string[]): Promise<number[][]> {
		return this.requestEmbeddings(texts, "retrieval.passage");
	}

	/** Query encoding uses the same model but its retrieval-specific query task. */
	async embedQuery(text: string): Promise<number[]> {
		return (await this.requestEmbeddings([text], "retrieval.query"))[0];
	}

	private async requestEmbeddings(texts: readonly string[], task: string): Promise<number[][]> {
		if (!texts.length) return [];
		const body = JSON.stringify({
			model: "jina-embeddings-v3",
			input: texts,
			task,
			dimensions: this.dimensions,
			embedding_type: "float",
			normalized: true,
			late_chunking: false,
			truncate: false,
		});
		// Three retries means four total attempts. Each attempt gets a fresh deadline covering body reads.
		for (let attempt = 0; ; attempt++) {
			let retryable = true;
			let rateLimited = false;
			let value: unknown;
			try {
				const response = await this.request("https://api.jina.ai/v1/embeddings", {
					method: "POST",
					headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) {
					retryable = response.status === 408 || response.status === 429 || response.status >= 500;
					rateLimited = response.status === 429;
					// Release the connection before retrying; never include error bodies or credentials in logs.
					await response.body?.cancel().catch(() => {});
					throw new Error(`Jina embedding request failed (HTTP ${response.status}).`);
				}
				value = await response.json();
			} catch (error) {
				if (retryable && !(error instanceof SyntaxError) && attempt < 3) {
					// Pause outside the request deadline; the next attempt gets a fresh 10 seconds.
					// Keep the batch pending so eval resumes without writing partial vectors.
					if (rateLimited) await delay(20_000);
					continue;
				}
				if (!retryable || error instanceof SyntaxError) throw error;
				// fetch hides DNS/TLS/connect failures in cause. Report only safe error codes.
				const cause = error instanceof Error ? error.cause : undefined;
				const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
				const reason =
					typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
						? code
						: error instanceof Error && error.name === "TimeoutError"
							? "REQUEST_TIMEOUT"
							: error instanceof Error && error.message.startsWith("Jina embedding request failed (HTTP ")
								? error.message
								: "FETCH_FAILED";
				throw new Error(`Jina embedding failed after ${attempt + 1} attempts (${reason}).`, { cause: error });
			}
			// Invalid successful responses are contract failures, not transient transport errors.
			return this.validateResponse(value, texts.length);
		}
	}

	/** Response order is not assumed: each unique index must cover exactly one input. */
	private validateResponse(value: unknown, count: number): number[][] {
		if (
			!value ||
			typeof value !== "object" ||
			!("data" in value) ||
			!Array.isArray(value.data) ||
			value.data.length !== count
		)
			throw new Error("Invalid Jina embedding response count.");
		const vectors = new Map<number, number[]>();
		for (const item of value.data as unknown[]) {
			if (!item || typeof item !== "object" || !("index" in item) || !("embedding" in item))
				throw new Error("Invalid Jina embedding item.");
			const { index, embedding } = item;
			if (
				typeof index !== "number" ||
				!Number.isInteger(index) ||
				index < 0 ||
				index >= count ||
				vectors.has(index) ||
				!Array.isArray(embedding)
			)
				throw new Error("Invalid Jina embedding index.");
			if (embedding.length !== this.dimensions) throw new Error("Invalid Jina embedding dimensions.");
			if (embedding.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v)))
				throw new Error("Jina embeddings must contain finite numbers.");
			vectors.set(index, embedding);
		}
		return Array.from({ length: count }, (_, index) => vectors.get(index)!);
	}
}
