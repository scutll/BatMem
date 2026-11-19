import type { QueryProcessor } from "../core/processor.ts";
import type { RecallResult, RetrievalHit, RetrievalQuery } from "../core/types.ts";

/** Preserve the single path's order, scores and coordinates. */
export class PassthroughProcessor<T extends RetrievalHit = RetrievalHit> implements QueryProcessor<T> {
	async process(_request: RetrievalQuery, results: RecallResult<T>[]): Promise<T[]> {
		if (results.length !== 1) throw new Error("Passthrough requires exactly one recall path.");
		return results[0].hits;
	}
}
