import { QueryRecall } from "./recall.ts";
import type { RetrievalHit, Retriever } from "./types.ts";

/** Default query combination; additional combinations register their own async task functions. */
export class BM25EmbeddingRecall<T extends RetrievalHit = RetrievalHit> extends QueryRecall<T> {
	constructor(bm25: Retriever<T>, vector: Retriever<T>) {
		super();
		this.addTask({ path: "bm25", run: async (request) => bm25.retrieve(request) });
		this.addTask({ path: "embedding", run: async (request) => vector.retrieve(request) });
	}
}
