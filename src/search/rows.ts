import type { SQLOutputValue } from "node:sqlite";
import type { DocumentRetrievalHit } from "../rag/types.ts";
import type { RetrievalHit } from "./types.ts";

/** Shared SQL projection keeps source identity identical across BM25 and vector retrieval. */
export function rowToHit(row: Record<string, SQLOutputValue>): RetrievalHit {
	if (row.source_type === "document") {
		const hit: DocumentRetrievalHit = {
			text: String(row.content),
			score: Number(row.score),
			sourceType: "document",
			sourceId: String(row.source_id),
			location: {
				sourcePath: String(row.source_path),
				chunkIndex: Number(row.chunk_index),
				startLine: Number(row.start_line),
				endLine: Number(row.end_line),
				section: row.section === null ? undefined : String(row.section),
			},
		};
		return hit;
	}
	return {
		text: String(row.content),
		score: Number(row.score),
		sourceType: "memory",
		sourceId: String(row.source_id),
		location: { sourcePath: String(row.source_path), entryId: String(row.entry_id), timestamp: String(row.timestamp) },
	};
}
