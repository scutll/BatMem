import { BM25EmbeddingRecall } from "./bm25-embedding-recall.ts";
import { EmbeddingQueryProcessor } from "./embedding-query-processor.ts";
import { createMultiBM25Options } from "./multiBm25Recall.ts";
import { ParallelRecall } from "./parallel-recall.ts";
import { PassthroughProcessor } from "./passthrough-processor.ts";
import type { RetrievalOptions } from "./types.ts";


/** Presets describe composition without reading credentials or creating providers. */
export const BM25_RECALL: RetrievalOptions = {
	id: "search",
	metadata: { recallPaths: ["bm25"], processor: "passthrough", score: "negated SQLite BM25; descending" },
	createRecall: ({ bm25 }) => new ParallelRecall([{ path: "bm25", run: (request) => bm25.retrieve(request) }]),
	createProcessor: () => new PassthroughProcessor(),
};

export const EMBEDDING_RECALL: RetrievalOptions = {
	id: "vsearch",
	requiresEmbedding: true,
	metadata: { recallPaths: ["embedding"], processor: "passthrough", score: "cosine similarity; descending" },
	createRecall: ({ vector }) => {
		if (!vector) throw new Error("Vector retriever is not configured.");
		return new ParallelRecall([{ path: "embedding", run: (request) => vector.retrieve(request) }]);
	},
	createProcessor: () => new PassthroughProcessor(),
};

export const BM25_EMBEDDING_RRF_RERANK_OPTIONS: RetrievalOptions = {
	id: "query",
	requiresEmbedding: true,
	metadata: {
		recallPaths: ["bm25", "embedding"],
		processor: "rrf-rerank-blend",
		score: "weighted reciprocal RRF rank and rerank score; descending",
	},
	createRecall: ({ bm25, vector }) => {
		if (!vector) throw new Error("Vector retriever is not configured.");
		return new BM25EmbeddingRecall(bm25, vector);
	},
	createProcessor: ({ reranker }) => new EmbeddingQueryProcessor(reranker),
};



export const DEFAULT_STRATEGIES: Readonly<Record<string, RetrievalOptions>> = {
	search: BM25_RECALL,
	vsearch: EMBEDDING_RECALL,
	query: BM25_EMBEDDING_RRF_RERANK_OPTIONS,
	multi_bm25: createMultiBM25Options(),
};

/** Names are resolved at application boundaries; services receive the selected object. */
export function selectRetrievalOptions(
	name: string,
	strategies: Readonly<Record<string, RetrievalOptions>> = DEFAULT_STRATEGIES,
): RetrievalOptions {
	if (!Object.hasOwn(strategies, name)) throw new Error(`Unknown retrieval strategy: ${name}`);
	return strategies[name];
}
