import type { EmbeddingProvider } from "../models/embedding/provider.ts";
import type { RerankingProvider } from "../models/reranking/provider.ts";
import type { RetrievalConfiguration } from "../retrieval/core/types.ts";

/** Extension composition options; a supplied embedding provider remains caller-owned. */
export interface BatMemOptions {
	retrieval?: RetrievalConfiguration;
	evalMode?: boolean;
	/** Undefined loads configuration; null explicitly disables embedding. */
	embedding?: EmbeddingProvider | null;
	/** Undefined loads configuration; injected instances remain caller-owned. */
	reranking?: RerankingProvider | null;
}
