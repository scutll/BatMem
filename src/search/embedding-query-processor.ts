import type { RerankingProvider } from "../reranking/provider.ts";
import type { QueryProcessor } from "./processor.ts";
import type { RecallResult, RetrievalHit, RetrievalQuery } from "./types.ts";

/** Fuse recall rankings, rerank candidates and blend model scores with fused ranks. */
export class EmbeddingQueryProcessor<T extends RetrievalHit = RetrievalHit> implements QueryProcessor<T> {
	/** Borrowed model provider, managed by the application entry point. */
	readonly reranker: RerankingProvider | undefined;
	private readonly rrfK: number;
	private readonly candidateLimit: number;

	constructor(reranker?: RerankingProvider, rrfK = 60) {
		if (!Number.isSafeInteger(rrfK) || rrfK < 0) throw new Error("rrfK must be a nonnegative safe integer.");
		this.reranker = reranker;
		this.rrfK = rrfK;
		this.candidateLimit = 40;
	}

	async process(request: RetrievalQuery, results: RecallResult<T>[]): Promise<T[]> {
		if (!Number.isSafeInteger(request.topK) || request.topK < 1) return [];
		const fused = new Map<string, { hit: T; rrfScore: number; bestRank: number }>();
		for (const { hits } of results) {
			const seen = new Set<string>();
			let rank = 0;
			for (const hit of hits) {
				const key = JSON.stringify([
					hit.sourceType,
					hit.sourceId,
					hit.sourceType === "document" ? hit.location.chunkIndex : null,
				]);
				// Each path contributes once per identity. Rank only its unique hits, in input order.
				if (seen.has(key)) continue;
				seen.add(key);
				rank++;
				const contribution = 1 / (this.rrfK + rank);
				const existing = fused.get(key);

				// Contributions from different recall paths accumulate for the same hit.
				if (existing) {
					existing.rrfScore += contribution;
					existing.bestRank = Math.min(existing.bestRank, rank);
				} else {
					fused.set(key, { hit, rrfScore: contribution, bestRank: rank });
				}
			}
		}

		// bonus for higer ranking results, the first result earns 0.05
		// 2nd/3rd result has 0.02 bonus
		const Rrf_result = [...fused.values()]
			.map(({ hit, rrfScore, bestRank }) => ({
				hit,
				score: rrfScore + (bestRank === 1 ? 0.05 : bestRank <= 3 ? 0.02 : 0),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, Math.max(this.candidateLimit, request.topK));

		const rerankCandidates: T[] = Rrf_result.map(({ hit }) => hit);

		if (!rerankCandidates.length) return [];
		if (!this.reranker) throw new Error("Reranker is not configured.");

		const rerankResult = await this.reranker?.rerank(request.query, rerankCandidates, rerankCandidates.length);

		// alpha differs with ranking, lower ranking chunks will have lower weight  on RRF scores,
		// leaving more weight for rerank scores
		return rerankResult
			?.map(({ index, score }) => {
				const hit = rerankCandidates[index];
				const rrfRank = index + 1;

				const alpha = rrfRank <= 3 ? 0.75 : rrfRank <= 10 ? 0.6 : 0.4;

				return {
					...hit,
					score: alpha / rrfRank + (1 - alpha) * score,
				};
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, request.topK);
	}
}
