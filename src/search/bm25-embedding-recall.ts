import { ParallelRecall } from "./parallel-recall.ts";
import type { RetrievalHit, Retriever } from "./types.ts";

/** Default query combination; additional combinations register their own async task functions. */
export class BM25EmbeddingRecall<T extends RetrievalHit = RetrievalHit> extends ParallelRecall<T> {
	constructor(bm25: Retriever<T>, vector: Retriever<T>) {
		super([
			{ path: "bm25", run: async (request) => bm25.retrieve(request) },
			{ path: "embedding", run: async (request) => vector.retrieve(request) },
		]);
	}
}
