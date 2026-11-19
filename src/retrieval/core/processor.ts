import type { RecallResult, RetrievalHit, RetrievalQuery } from "./types.ts";

/** Process all successful recall paths using the original request. */
export interface QueryProcessor<T extends RetrievalHit = RetrievalHit> {
	process(request: RetrievalQuery, results: RecallResult<T>[]): Promise<T[]>;
}
