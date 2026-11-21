import type { Database } from "../../../storage/database.ts";
import type { SQLiteQuery } from "../../../storage/query-executor-types.ts";
import type { RetrievalHit, RetrievalQuery, RecallSource } from "../../core/types.ts";
import { rowToHit } from "../../../storage/retrieval-row.ts";

/** Source-scoped FTS5 recall. Native BM25 is negated to expose a higher-is-better score. */
export class BM25Retriever implements RecallSource {
	private readonly db: Database;
	private readonly source: RetrievalHit["sourceType"];

	constructor(db: Database, source: RetrievalHit["sourceType"]) {
		this.db = db;
		this.source = source;
	}

	async retrieve(request: RetrievalQuery): Promise<RetrievalHit[]> {
		const query = this.buildQuery(request);
		return query ? (await this.db.executor.execute(query)).map(rowToHit) : [];
	}

	/** Synchronous core also serves existing business-service callers. No disk scan or model request. */
	search(request: RetrievalQuery): RetrievalHit[] {
		const query = this.buildQuery(request);
		return query ? this.db.prepare(query.sql).all(...(query.parameters ?? [])).map(rowToHit) : [];
	}

	private buildQuery({ query, topK }: RetrievalQuery): SQLiteQuery | undefined {
		const terms = query.match(/[\p{L}\p{N}_]+/gu);
		if (!terms?.length || !Number.isSafeInteger(topK) || topK < 1) return undefined;
		const table = this.source === "document" ? "chunks_fts" : "summaries_fts";
		const tie = this.source === "document" ? "u.source_path, u.chunk_index" : "u.source_id";
		// Table/order expressions are selected internally; user text is always a bound parameter.
		return {
			sql: `SELECT u.*, -bm25(${table}) AS score FROM ${table}
			JOIN retrieval_units u ON u.unit_id = ${table}.rowid AND u.source_type = ?
			WHERE ${table} MATCH ? ORDER BY score DESC, ${tie} LIMIT ?`,
			parameters: [this.source, terms.map((term) => `"${term}"`).join(" OR "), topK],
		};
	}
}
