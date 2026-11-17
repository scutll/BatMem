import type { DatabaseSync } from "node:sqlite";
import type { RetrievalHit, RetrievalQuery, Retriever } from "./types.ts";
import { rowToHit } from "./rows.ts";

/** Source-scoped FTS5 recall. Native BM25 is negated to expose a higher-is-better score. */
export class BM25Retriever implements Retriever {
	private readonly db: DatabaseSync;
	private readonly source: RetrievalHit["sourceType"];

	constructor(db: DatabaseSync, source: RetrievalHit["sourceType"]) {
		this.db = db;
		this.source = source;
	}

	async retrieve(request: RetrievalQuery): Promise<RetrievalHit[]> {
		return this.search(request);
	}

	/** Synchronous core also serves existing business-service callers. No disk scan or model request. */
	search({ query, topK }: RetrievalQuery): RetrievalHit[] {
		const terms = query.match(/[\p{L}\p{N}_]+/gu);
		if (!terms?.length || !Number.isSafeInteger(topK) || topK < 1) return [];
		const table = this.source === "document" ? "chunks_fts" : "summaries_fts";
		const tie = this.source === "document" ? "u.source_path, u.chunk_index" : "u.source_id";
		// Table/order expressions are selected internally; user text is always a bound parameter.
		return this.db
			.prepare(`SELECT u.*, -bm25(${table}) AS score FROM ${table}
			JOIN retrieval_units u ON u.unit_id = ${table}.rowid AND u.source_type = ?
			WHERE ${table} MATCH ? ORDER BY score DESC, ${tie} LIMIT ?`)
			.all(this.source, terms.map((term) => `"${term}"`).join(" OR "), topK)
			.map(rowToHit);
	}
}
