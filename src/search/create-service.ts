import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../embedding/provider.ts";
import { VectorIndex } from "../embedding/vector-index.ts";
import type { RerankingProvider } from "../reranking/provider.ts";
import { BM25Retriever } from "./bm25.ts";
import { SearchService } from "./service.ts";
import type { RetrievalHit, RetrievalService } from "./types.ts";
import { VectorRetriever } from "./vector.ts";

/** Bind retrievers to one connection and source. No indexing or provider allocation. */
export function createSearchService(
	db: DatabaseSync,
	sourceType: RetrievalHit["sourceType"],
	embedding?: EmbeddingProvider,
	reranker?: RerankingProvider,
): RetrievalService {
	return new SearchService({
		sourceType,
		bm25: new BM25Retriever(db, sourceType),
		vector: embedding ? new VectorRetriever(new VectorIndex(db, embedding), embedding, sourceType) : undefined,
		reranker,
	});
}
