import { BM25EmbeddingRecall } from "../recall/bm25-embedding.ts";
import { EmbeddingQueryProcessor } from "../processors/rrf-rerank-blend.ts";
import { ParallelRecall } from "../recall/parallel.ts";
import { PassthroughProcessor } from "../processors/passthrough.ts";
import type { RetrievalOptions } from "../core/types.ts";

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
