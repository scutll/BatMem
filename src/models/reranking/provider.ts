import type { RetrievalHit } from "../../retrieval/core/types.ts";
import type { RerankResult } from "./types.ts";

/** Rank recalled hits together against a query; reject the entire failed request. */
export abstract class RerankingProvider {
	/** Stable model identity, excluding credentials and transport settings. */
	abstract readonly identity: string;
	/** Return min(topK, hits.length) results by descending score. Invalid limits or no hits return []. */
	abstract rerank(query: string, hits: readonly RetrievalHit[], topK: number): Promise<RerankResult[]>;

	/** Preserve every hit's position, including duplicate or blank texts, so response indices map to the input. */
	protected toDocuments(hits: readonly RetrievalHit[]): string[] {
		return hits.map((hit) => hit.text);
	}
}
