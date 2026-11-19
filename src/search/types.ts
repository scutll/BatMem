import type { RerankingProvider } from "../reranking/provider.ts";
import type { QueryProcessor } from "./processor.ts";
import type { QueryRecall } from "./recall.ts";

/** Shared search contract for session summaries and document chunks. */
export interface RetrievalQuery {
	/** Plain text. BM25 quotes extracted terms; vector retrieval encodes the original text. */
	query: string;
	/** Positive integer result limit; invalid limits return an empty result. */
	topK: number;
}

/** Result with source coordinates. Scores from different FTS indexes are not calibrated for merging. */
export interface RetrievalHit {
	text: string;
	/** Larger ranks first. Algorithm-specific, not a probability or comparable across retrievers. */
	score: number;
	sourceType: "memory" | "document";
	/** Session ID for memory results, document ID for document results. */
	sourceId: string;
	/** Memory supplies entryId/timestamp; documents supply chunk and line coordinates. */
	location: {
		sourcePath: string;
		entryId?: string;
		timestamp?: string;
		chunkIndex?: number;
		startLine?: number;
		endLine?: number;
		section?: string;
	};
}

/** Common async recall contract; retrievers do not interpret query expansion or perform fusion. */
export interface Retriever<T extends RetrievalHit = RetrievalHit> {
	retrieve(request: RetrievalQuery): Promise<T[]>;
}

/** A named async path may prepare its own query and postprocess its recalled hits. */
export interface RecallTask<T extends RetrievalHit = RetrievalHit> {
	path: string;
	run: (request: RetrievalQuery) => Promise<T[]>;
}

/** One path's ordered results, including an empty successful recall. */
export interface RecallResult<T extends RetrievalHit = RetrievalHit> {
	path: string;
	hits: T[];
}

/** Source-bound dependencies live as long as the index connection. Factories borrow them. */
export interface RetrievalDependencies<T extends RetrievalHit = RetrievalHit> {
	readonly sourceType: RetrievalHit["sourceType"];
	readonly bm25: Retriever<T>;
	readonly vector?: Retriever<T>;
	readonly reranker?: RerankingProvider;
}

/** Serializable experiment description supplied alongside the actual factories. */
export interface RetrievalMetadata {
	readonly recallPaths: readonly string[];
	readonly processor: string;
	readonly score: string;
}

/** One strategy; factories create request-local execution objects. */
export interface RetrievalOptions<T extends RetrievalHit = RetrievalHit> {
	readonly id: string;
	readonly requiresEmbedding?: boolean;
	readonly metadata?: RetrievalMetadata;
	readonly createRecall: (deps: RetrievalDependencies<T>) => QueryRecall<T>;
	readonly createProcessor: (deps: RetrievalDependencies<T>) => QueryProcessor<T>;
}

export interface RetrievalService<T extends RetrievalHit = RetrievalHit> {
	retrieve(request: RetrievalQuery, options: RetrievalOptions<T>): Promise<T[]>;
}

export interface RetrievalConfiguration {
	readonly defaultStrategy?: string;
	readonly strategies?: Readonly<Record<string, RetrievalOptions>>;
}
