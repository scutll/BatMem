import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Captured SessionManager data for one complete, append-only conversation. No branch selection occurs. */
export interface SessionSnapshot {
	/** Stable session identity used to scope messages and the current summary. */
	sessionId: string;
	/** Original JSONL path, or an empty string for in-memory sessions. Not read by the service. */
	sourcePath: string;
	/** Session working directory; recorded as provenance, not used to choose the database. */
	projectPath: string;
	/** Complete entries in conversation order, including previously synchronized entries. */
	entries: SessionEntry[];
}

/** Searchable message projection. Original session files remain the source of truth. */
export interface IndexedMessage {
	sessionId: string;
	entryId: string;
	role: "user" | "assistant" | "toolResult";
	/** Text blocks and serialized tool calls; images and thinking blocks are omitted. */
	text: string;
	/** ISO session-entry timestamp used for newest-first raw reads. */
	timestamp: string;
	sourcePath: string;
}

/** Current session summary. Text and processing cursor are saved together after successful generation. */
export interface SessionSummary {
	sessionId: string;
	/** Last included message entry; an incremental cursor, not a branch identifier. */
	leafEntryId: string;
	text: string;
	/** ISO summary update time, not the time of the last conversation message. */
	timestamp: string;
}

/** Return nonempty summary text for prepared input; reject on failure. Does not imply automatic retries. */
export type SummaryGenerator = (input: string) => Promise<string>;
/** Shared search contract for session summaries and document chunks. */
export interface RetrievalQuery {
	/** Plain text, not trusted FTS syntax. Extracted terms are quoted and combined with OR. */
	query: string;
	/** Positive integer result limit; invalid limits return an empty result. */
	topK: number;
}

/** Result with source coordinates. Scores from different FTS indexes are not calibrated for merging. */
export interface RetrievalHit {
	text: string;
	/** Native SQLite BM25 score: smaller values rank first. Not a probability. */
	score: number;
	sourceType: "memory" | "document";
	/** Session ID for memory results, document ID for document results. */
	sourceId: string;
	/** Memory supplies entryId/timestamp; documents supply chunk and line coordinates. */
	location: {
		sourcePath: string;
		entryId?: string;
		timestamp?: string;
		chunkIndex?: number;
		startLine?: number;
		endLine?: number;
		section?: string;
	};
}

/** Stored document identity and fingerprint; the original file is retained. */
export interface DocumentRecord {
	id: string;
	sourcePath: string;
	/** SHA-256 of decoded UTF-8 content; independent of file size and modification time. */
	contentHash: string;
	/** ISO file modification time captured when content was indexed. */
	modifiedAt: string;
}

/** Document result guarantees coordinates usable by the built-in read tool. */
export interface DocumentRetrievalHit extends RetrievalHit {
	sourceType: "document";
	location: { sourcePath: string; chunkIndex: number; startLine: number; endLine: number; section?: string };
}

/** Source-preserving Markdown slice with coordinates in the unmodified original text. */
export interface DocumentChunk {
	text: string;
	/** Zero-based position within the document. */
	chunkIndex: number;
	/** One-based inclusive source line range; a trailing newline does not add a covered line. */
	startLine: number;
	endLine: number;
	/** Active ATX heading at chunk start, without # markers; absent before the first heading. */
	section?: string;
}
