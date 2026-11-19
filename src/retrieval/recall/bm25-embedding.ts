import { ParallelRecall } from "./parallel.ts";
import type { RetrievalHit, RecallSource } from "../core/types.ts";

/** Default query combination; additional combinations register their own async task functions. */
export class BM25EmbeddingRecall<T extends RetrievalHit = RetrievalHit> extends ParallelRecall<T> {
	constructor(bm25: RecallSource<T>, vector: RecallSource<T>) {
		super([
			{ path: "bm25", run: async (request) => bm25.retrieve(request) },
			{ path: "embedding", run: async (request) => vector.retrieve(request) },
		]);
	}
}
