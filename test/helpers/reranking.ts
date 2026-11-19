import { RerankingProvider } from "../../src/reranking/provider.ts";
import type { RerankResult } from "../../src/reranking/types.ts";
import { EmbeddingQueryProcessor } from "../../src/search/embedding-query-processor.ts";
import { BM25_EMBEDDING_RRF_RERANK_OPTIONS } from "../../src/search/strategies.ts";
import type { RetrievalHit, RetrievalOptions } from "../../src/search/types.ts";

/** Offline scores returned in reverse input order to expose accidental use of response position as rank. */
export class OfflineReranker extends RerankingProvider {
	readonly identity = "test/reranking:v1";
	readonly calls: { query: string; hits: readonly RetrievalHit[]; topK: number }[] = [];
	private readonly scores: readonly number[];

	constructor(scores: readonly number[] = []) {
		super();
		this.scores = scores;
	}

	async rerank(query: string, hits: readonly RetrievalHit[], topK: number): Promise<RerankResult[]> {
		this.calls.push({ query, hits: [...hits], topK });
		return hits
			.map((_, index) => ({ index, score: this.scores[index] ?? 0 }))
			.reverse()
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}
}

/** Exercise production fusion with an explicitly injected offline provider. */
export const OFFLINE_HYBRID_OPTIONS: RetrievalOptions = {
	...BM25_EMBEDDING_RRF_RERANK_OPTIONS,
	createProcessor: () => new EmbeddingQueryProcessor(new OfflineReranker()),
};
