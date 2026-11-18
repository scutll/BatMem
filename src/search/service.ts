import { BM25EmbeddingRecall } from "./bm25-embedding-recall.ts";
import { EmbeddingQueryProcessor } from "./embedding-query-processor.ts";
import type { QueryPipeline, RetrievalHit, RetrievalQuery, Retriever } from "./types.ts";

/** Stable public search entry points. Strategy selection is explicit; vector errors never become BM25 results. */
export class SearchService<T extends RetrievalHit = RetrievalHit> {
	private readonly bm25: Retriever<T>;
	private readonly vector?: Retriever<T>;
	private readonly pipeline?: QueryPipeline<T>;

	constructor(bm25: Retriever<T>, vector?: Retriever<T>, pipeline?: QueryPipeline<T>) {
		this.bm25 = bm25;
		this.vector = vector;
		this.pipeline =
			pipeline ??
			(vector
				? { recall: new BM25EmbeddingRecall(bm25, vector), processor: new EmbeddingQueryProcessor<T>() }
				: undefined);
	}

	search(request: RetrievalQuery): Promise<T[]> {
		return this.bm25.retrieve(request);
	}

	async vsearch(request: RetrievalQuery): Promise<T[]> {
		if (!this.vector) throw new Error("Vector search is not configured.");
		return this.vector.retrieve(request);
	}

	async query(request: RetrievalQuery): Promise<T[]> {
		if (!this.pipeline) throw new Error("Query search is not configured; the default pipeline requires vector search.");
		const original = { ...request };
		const results = await this.pipeline.recall.recall(original);
		return this.pipeline.processor.process(original, results);
	}
}
