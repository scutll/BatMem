import type { EmbeddingProvider } from "./embedding/provider.ts";
import type { SearchMode } from "./search/types.ts";

/** Extension composition options; a supplied embedding provider remains caller-owned. */
export interface BatMemOptions {
	memorySearchMode?: SearchMode;
	evalMode?: boolean;
	/** Undefined loads configuration; null explicitly disables embedding. */
	embedding?: EmbeddingProvider | null;
}
