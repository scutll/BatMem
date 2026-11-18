import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../embedding/provider.ts";
import { VectorIndex } from "../embedding/vector-index.ts";
import { BM25Retriever } from "../search/bm25.ts";
import { SearchService } from "../search/service.ts";
import type { RetrievalHit, RetrievalQuery, SearchMode } from "../search/types.ts";
import { VectorRetriever } from "../search/vector.ts";
import type { IndexedMessage, SessionSnapshot, SessionSummary, SummaryGenerator } from "./types.ts";

/** Session indexing and retrieval independent of extension events and concrete model providers. */
export class MemoryService {
	private readonly db: DatabaseSync;
	private readonly vectors?: VectorIndex;
	private readonly search: SearchService;
	/** Existing summaries are checked for missing vectors as soon as the service opens. */
	readonly ready: Promise<void>;
	/** Use a caller-owned database; an optional provider enables summary vectors and vsearch. */
	constructor(db: DatabaseSync, embedding?: EmbeddingProvider) {
		this.db = db;
		this.vectors = embedding ? new VectorIndex(db, embedding) : undefined;
		this.search = new SearchService(
			new BM25Retriever(db, "memory"),
			this.vectors && embedding ? new VectorRetriever(this.vectors, embedding, "memory") : undefined,
		);
		this.ready = this.vectors?.syncEmbeddings("memory") ?? Promise.resolve();
		// Standalone BM25 callers need not observe startup backfill; explicit vector calls still check readiness.
		void this.ready.catch(() => {});
	}

	/**
	 * Commit raw messages, then create or incrementally replace the current session summary.
	 * No new messages means no summary model call; missing vectors are still backfilled.
	 * Callers must serialize syncs for the same session.
	 *
	 * @param snapshot Complete entries in conversation order; previously saved messages must still be present.
	 * @param generateSummary Model adapter or test substitute; receives the old summary and only new messages.
	 * @throws Missing saved cursor, database errors, failed generation, or empty generated text.
	 * Generation failure preserves committed raw messages and the previous summary/cursor. No automatic retry.
	 */
	async syncSession(snapshot: SessionSnapshot, generateSummary: SummaryGenerator): Promise<void> {
		// Startup backfill may fail; a new sync gets another chance to fill the missing vectors.
		await this.ready.catch(() => {});
		const messages = this.extractMessages(snapshot);
		this.saveSessionMessages(snapshot, messages);
		const previous = this.getSessionSummary(snapshot.sessionId);
		const newMessages = this.selectNewMessages(messages, previous?.leafEntryId);
		if (!newMessages.length) {
			await this.vectors?.syncEmbeddings("memory");
			return;
		}
		// Never hold a write transaction while waiting on a model request.
		const text = await generateSummary(this.buildSummaryInput(previous, newMessages));
		if (!text.trim()) throw new Error("Summary response was empty.");
		this.saveSessionSummary({
			sessionId: snapshot.sessionId,
			leafEntryId: newMessages[newMessages.length - 1].entryId,
			text,
			timestamp: new Date().toISOString(),
		});
		// The summary is durable before the HTTP call. Failure leaves its vector pending for the next sync.
		await this.vectors?.syncEmbeddings("memory");
	}

	/**
	 * Search current summaries. `search` uses FTS5 BM25; `vsearch` embeds the query and
	 * retrieves stored summary vectors. `query` recalls both and currently returns embedding hits.
	 * A missing or incomplete vector index rejects vector and query searches.
	 */
	async searchSummaries(request: RetrievalQuery, mode: SearchMode = "search"): Promise<RetrievalHit[]> {
		if (mode !== "search") {
			await this.ready.catch(() => {});
		}
		return this.search[mode](request);
	}

	/**
	 * Read up to three user/assistant messages containing a case-sensitive literal substring.
	 * Tool results remain indexed for summarization but are excluded from raw read results.
	 *
	 * @param sessionId Exact session ID from summary search.
	 * @param keyword Literal substring; %, _ and quotes have no SQL operator meaning.
	 * @returns Newest-first messages; insertion order breaks timestamp ties. Empty keyword or no match returns [].
	 */
	readMessages(sessionId: string, keyword: string): IndexedMessage[] {
		if (!keyword) return [];
		return this.db
			.prepare(`SELECT m.*, s.source_path FROM messages m JOIN sessions s ON s.id = m.session_id
			WHERE m.session_id = ? AND m.role IN ('user', 'assistant') AND instr(m.content, ?) > 0
			ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 3`)
			.all(sessionId, keyword)
			.map((row) => ({
				sessionId: String(row.session_id),
				entryId: String(row.entry_id),
				role: row.role as IndexedMessage["role"],
				text: String(row.content),
				timestamp: String(row.timestamp),
				sourcePath: String(row.source_path),
			}));
	}

	/** Preserve order and provenance, omitting non-message entries and non-text media/thinking blocks. */
	private extractMessages(snapshot: SessionSnapshot): IndexedMessage[] {
		const messages: IndexedMessage[] = [];
		for (const entry of snapshot.entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.flatMap((part) =>
								part.type === "text"
									? [part.text]
									: part.type === "toolCall"
										? [`Tool call ${part.name}: ${JSON.stringify(part.arguments)}`]
										: [],
							)
							.join("\n");
			messages.push({
				sessionId: snapshot.sessionId,
				entryId: entry.id,
				role: message.role,
				text,
				timestamp: entry.timestamp,
				sourcePath: snapshot.sourcePath,
			});
		}
		return messages;
	}

	/** Commit session metadata and raw messages together; existing entry IDs are treated as immutable. */
	private saveSessionMessages(snapshot: SessionSnapshot, messages: IndexedMessage[]): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(`INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET
				source_path=excluded.source_path, project_path=excluded.project_path`)
				.run(snapshot.sessionId, snapshot.sourcePath, snapshot.projectPath);
			const insert = this.db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(session_id, entry_id) DO NOTHING`);
			for (const message of messages)
				insert.run(message.sessionId, message.entryId, message.role, message.text, message.timestamp);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Return the current checkpoint, or undefined if the session has not been summarized. */
	private getSessionSummary(sessionId: string): SessionSummary | undefined {
		const row = this.db.prepare("SELECT * FROM summaries WHERE session_id = ?").get(sessionId);
		return row
			? {
					sessionId,
					leafEntryId: String(row.leaf_entry_id),
					text: String(row.content),
					timestamp: String(row.timestamp),
				}
			: undefined;
	}

	/**
	 * Select messages after the saved entry, or all messages on first sync.
	 * A missing cursor is an input-contract error; restarting silently would hide unsupported history changes.
	 */
	private selectNewMessages(messages: IndexedMessage[], lastEntryId?: string): IndexedMessage[] {
		if (!lastEntryId) return messages;
		const index = messages.findIndex((message) => message.entryId === lastEntryId);
		if (index === -1) throw new Error(`Saved summary entry ${lastEntryId} is missing from the session.`);
		return messages.slice(index + 1);
	}

	/** Carry earlier facts through the previous summary instead of resending old raw messages. */
	private buildSummaryInput(previous: SessionSummary | undefined, messages: IndexedMessage[]): string {
		return `${previous ? `Previous summary:\n${previous.text}\n\n` : ""}New conversation messages:\n${messages
			.map((message) => `[${message.timestamp}] ${message.role}: ${message.text}`)
			.join("\n\n")}`;
	}

	/** Replace text and cursor together; never advance the processing position before generation succeeds. */
	private saveSessionSummary(summary: SessionSummary): void {
		// One statement atomically updates the checkpoint and its trigger-maintained FTS entry.
		this.db
			.prepare(`INSERT INTO summaries VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
			leaf_entry_id=excluded.leaf_entry_id, content=excluded.content, timestamp=excluded.timestamp`)
			.run(summary.sessionId, summary.leafEntryId, summary.text, summary.timestamp);
	}
}
