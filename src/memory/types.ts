import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EmbeddingProvider } from "../embedding/provider.ts";
import type { RetrievalService } from "../search/types.ts";

export interface MemoryServiceOptions {
	embedding?: EmbeddingProvider;
	search?: RetrievalService;
	/** Evaluation reads existing vectors without startup writes. Default: true. */
	backfill?: boolean;
}

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
