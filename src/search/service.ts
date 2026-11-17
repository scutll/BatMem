import type { RetrievalHit, RetrievalQuery, Retriever } from "./types.ts";

/** Stable public search entry points. Strategy selection is explicit; vector errors never become BM25 results. */
export class SearchService<T extends RetrievalHit = RetrievalHit> {
	private readonly bm25: Retriever<T>;
	private readonly vector?: Retriever<T>;

	constructor(bm25: Retriever<T>, vector?: Retriever<T>) {
		this.bm25 = bm25;
		this.vector = vector;
	}

	search(request: RetrievalQuery): Promise<T[]> {
		return this.bm25.retrieve(request);
	}

	async vsearch(request: RetrievalQuery): Promise<T[]> {
		if (!this.vector) throw new Error("Vector search is not configured.");
		return this.vector.retrieve(request);
	}
}
