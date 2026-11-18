import type { MockTracker } from "node:test";
import { RerankingProvider } from "../../src/reranking/provider.ts";
import type { RerankResult } from "../../src/reranking/types.ts";
import { EmbeddingQueryProcessor } from "../../src/search/embedding-query-processor.ts";
import type { RecallResult, RetrievalHit, RetrievalQuery } from "../../src/search/types.ts";

const processQuery = EmbeddingQueryProcessor.prototype.process;

/** Keep integration tests on the production fusion path with offline model scores, regardless of local credentials. */
export function mockReranking(mock: MockTracker): OfflineReranker {
	const reranker = new OfflineReranker();
	mock.method(EmbeddingQueryProcessor.prototype, "process", (request: RetrievalQuery, results: RecallResult[]) =>
		processQuery.call(new EmbeddingQueryProcessor(reranker), request, results),
	);
	return reranker;
}

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
