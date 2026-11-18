import type { QueryProcessor } from "./processor.ts";
import type { QueryRecall } from "./recall.ts";

export type SearchMode = "search" | "vsearch" | "query";

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

export interface QueryPipeline<T extends RetrievalHit = RetrievalHit> {
	recall: QueryRecall<T>;
	processor: QueryProcessor<T>;
}
