import type { RecallResult, RetrievalHit, RetrievalQuery } from "./types.ts";

/** Independently ranked paths; each path owns its query and result preparation. */
export interface QueryRecall<T extends RetrievalHit = RetrievalHit> {
	recall(request: RetrievalQuery): Promise<RecallResult<T>[]>;
}
