import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as rerankingFetch, ProxyAgent } from "undici";
import type { RetrievalHit } from "../search/types.ts";
import { RerankingProvider } from "./provider.ts";
import type { JinaRerankingOptions, RerankResult } from "./types.ts";

/** Jina v3 HTTP adapter. 10-second attempts, up to three retries, and a 20-second pause after HTTP 429. */
export class JinaRerankingProvider extends RerankingProvider {
	readonly identity = "jina.ai/jina-reranker-v3:v1";
	private readonly apiKey: string;
	private readonly dispatcher?: Agent | ProxyAgent;
	private readonly request: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
	) => Promise<Pick<Response, "ok" | "status" | "json"> & { body?: { cancel(): Promise<void> } | null }>;

	constructor(options: JinaRerankingOptions) {
		super();
		if (!options.apiKey.trim()) throw new Error("JINA_API_KEY is required for reranking.");
		if (options.model && options.model !== "jina-reranker-v3") throw new Error("Only jina-reranker-v3 is supported.");
		this.apiKey = options.apiKey;
		// Keep fetch and its dispatcher on the same undici version. Explicit direct mode ignores host proxies.
		this.dispatcher = options.fetch ? undefined : options.proxyUrl ? new ProxyAgent(options.proxyUrl) : new Agent();
		this.request = options.fetch ?? ((url, init) => rerankingFetch(url, { ...init, dispatcher: this.dispatcher }));
	}

	/** Release owned HTTP connections after pending reranking calls finish. */
	async close(): Promise<void> {
		await this.dispatcher?.close();
	}

	/** Send the whole candidate set in one request: v3 ranks documents jointly. */
	async rerank(query: string, hits: readonly RetrievalHit[], topK: number): Promise<RerankResult[]> {
		if (!hits.length || !Number.isSafeInteger(topK) || topK < 1) return [];
		if (!query.trim()) throw new Error("Reranking query must not be blank.");
		const documents = this.toDocuments(hits);
		const count = Math.min(topK, documents.length);
		// API reference: https://github.com/jina-ai/meta-prompt/blob/main/v11.txt (Reranker API).
		const body = JSON.stringify({
			model: "jina-reranker-v3",
			query,
			documents,
			top_n: count,
			return_documents: false,
		});
		// Three retries means four total attempts. Each deadline also covers response body reads.
		for (let attempt = 0; ; attempt++) {
			let retryable = true;
			let rateLimited = false;
			let value: unknown;
			try {
				const response = await this.request("https://api.jina.ai/v1/rerank", {
					method: "POST",
					headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(10_000),
				});
				if (!response.ok) {
					retryable = response.status === 408 || response.status === 429 || response.status >= 500;
					rateLimited = response.status === 429;
					// Release the connection; never include error bodies or credentials in logs.
					await response.body?.cancel().catch(() => {});
					throw new Error(`Jina reranking request failed (HTTP ${response.status}).`);
				}
				value = await response.json();
			} catch (error) {
				if (retryable && !(error instanceof SyntaxError) && attempt < 3) {
					if (rateLimited) await delay(20_000);
					continue;
				}
				if (!retryable || error instanceof SyntaxError) throw error;
				const cause = error instanceof Error ? error.cause : undefined;
				const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
				const reason =
					typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
						? code
						: error instanceof Error && error.name === "TimeoutError"
							? "REQUEST_TIMEOUT"
							: error instanceof Error && error.message.startsWith("Jina reranking request failed (HTTP ")
								? error.message
								: "FETCH_FAILED";
				throw new Error(`Jina reranking failed after ${attempt + 1} attempts (${reason}).`, { cause: error });
			}
			// Invalid successful responses are contract failures, not transient transport errors.
			return this.validateResponse(value, documents.length, count);
		}
	}

	private validateResponse(value: unknown, documentCount: number, count: number): RerankResult[] {
		if (
			!value ||
			typeof value !== "object" ||
			!("results" in value) ||
			!Array.isArray(value.results) ||
			value.results.length !== count
		)
			throw new Error("Invalid Jina reranking response count.");
		const indices = new Set<number>();
		const results: RerankResult[] = [];
		for (const item of value.results as unknown[]) {
			if (!item || typeof item !== "object" || !("index" in item) || !("relevance_score" in item))
				throw new Error("Invalid Jina reranking item.");
			const { index, relevance_score: score } = item;
			if (
				typeof index !== "number" ||
				!Number.isInteger(index) ||
				index < 0 ||
				index >= documentCount ||
				indices.has(index)
			)
				throw new Error("Invalid Jina reranking index.");
			if (typeof score !== "number" || !Number.isFinite(score))
				throw new Error("Jina reranking scores must be finite numbers.");
			indices.add(index);
			results.push({ index, score });
		}
		return results.sort((a, b) => b.score - a.score);
	}
}
