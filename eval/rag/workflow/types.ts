import type { Database } from "../../../src/storage/database.ts";
import type { EmbeddingProvider } from "../../../src/models/embedding/provider.ts";
import type { RerankingProvider } from "../../../src/models/reranking/provider.ts";
import type { RetrievalHit, RetrievalOptions, RetrievalQuery } from "../../../src/retrieval/core/types.ts";
import type { DatasetLoader } from "../datasets/types.ts";

export interface CorpusBuild {
	db: Database;
	path: string;
	fingerprint: string;
	count: number;
	reused: boolean;
	/** Release both the content connection and its process-owned build lock. */
	close(): Promise<void>;
}

/** One corpus row becomes one indexed chunk. No Markdown scanning or chunking is performed. */
export interface RetrievalEvalOptions {
	loader: DatasetLoader;
	/** New directory, created exclusively; existing experiment files are never overwritten. */
	output: string;
	/** Shared build root. Omit for an isolated database inside output (e.g. in-memory adapter tests). */
	builds?: string;
	topK?: number;
	retrieval: RetrievalOptions;
	embedding?: EmbeddingProvider;
	reranking?: RerankingProvider;
}

/** Export consumes ordered hits only; dataset formats and retrieval strategies stay outside this contract. */
export type RetrievalFunction = (request: RetrievalQuery) => Promise<RetrievalHit[]>;
