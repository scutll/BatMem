import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../models/embedding/provider.ts";
import { VectorIndex } from "../storage/vector-index.ts";
import type { RerankingProvider } from "../models/reranking/provider.ts";
import { BM25Retriever } from "./recall/utils/bm25.ts";
import { Retriever } from "./core/retriever.ts";
import type { RetrievalHit, QueryRetriever } from "./core/types.ts";
import { VectorRetriever } from "./recall/utils/vector.ts";

/** Bind retrievers to one connection and source. No indexing or provider allocation. */
export function createRetriever(
	db: DatabaseSync,
	sourceType: RetrievalHit["sourceType"],
	embedding?: EmbeddingProvider,
	reranker?: RerankingProvider,
): QueryRetriever {
	return new Retriever({
		sourceType,
		bm25: new BM25Retriever(db, sourceType),
		vector: embedding ? new VectorRetriever(new VectorIndex(db, embedding), embedding, sourceType) : undefined,
		reranker,
	});
}
