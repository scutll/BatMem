import type { RetrievalOptions } from "../core/types.ts";
import { createMultiBM25Options } from "./multi-bm25.ts";
import { createMultiBM25EmbeddingOptions } from "./multi-bm25-embedding.ts";
import { BM25_RECALL, EMBEDDING_RECALL, BM25_EMBEDDING_RRF_RERANK_OPTIONS } from "./presets.ts";

export const DEFAULT_STRATEGIES: Readonly<Record<string, RetrievalOptions>> = {
	search: BM25_RECALL,
	vsearch: EMBEDDING_RECALL,
	query: BM25_EMBEDDING_RRF_RERANK_OPTIONS,
	multi_bm25: createMultiBM25Options(),
	weighted_bme: createMultiBM25EmbeddingOptions(),
};

/** Names are resolved at application boundaries; services receive the selected object. */
export function selectRetrievalOptions(
	name: string,
	strategies: Readonly<Record<string, RetrievalOptions>> = DEFAULT_STRATEGIES,
): RetrievalOptions {
	if (!Object.hasOwn(strategies, name)) throw new Error(`Unknown retrieval strategy: ${name}`);
	return strategies[name];
}

export const SEARCH_MODES: readonly string[] = Object.keys(DEFAULT_STRATEGIES);

/** Validate modes at CLI and other untyped boundaries. */
export function isSearchMode(value: unknown): value is string {
	return SEARCH_MODES.some((mode) => mode === value);
}
