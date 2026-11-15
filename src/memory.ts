import type { DatabaseSync } from "node:sqlite";
import type {
	IndexedMessage,
	RetrievalHit,
	RetrievalQuery,
	SessionSnapshot,
	SessionSummary,
	SummaryGenerator,
} from "./types.ts";

/** Session indexing/retrieval independent of extension events and model providers. */
export class MemoryService {
	private readonly db: DatabaseSync;
	/** Use an initialized connection from openDatabase(); ownership remains with the caller. */
	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/**
	 * Commit raw messages, then create or incrementally replace the current session summary.
	 * No new messages means no model call. Callers must serialize syncs for the same session.
	 *
	 * @param snapshot Complete entries in conversation order; previously saved messages must still be present.
	 * @param generateSummary Model adapter or test substitute; receives the old summary and only new messages.
	 * @throws Missing saved cursor, database errors, failed generation, or empty generated text.
	 * Generation failure preserves committed raw messages and the previous summary/cursor. No automatic retry.
	 */
	async syncSession(snapshot: SessionSnapshot, generateSummary: SummaryGenerator): Promise<void> {
		const messages = this.extractMessages(snapshot);
		this.saveSessionMessages(snapshot, messages);
		const previous = this.getSessionSummary(snapshot.sessionId);
		const newMessages = this.selectNewMessages(messages, previous?.leafEntryId);
		if (!newMessages.length) return;
		// Never hold a write transaction while waiting on a model request.
		const text = await generateSummary(this.buildSummaryInput(previous, newMessages));
		if (!text.trim()) throw new Error("Summary response was empty.");
		this.saveSessionSummary({
			sessionId: snapshot.sessionId,
			leafEntryId: newMessages[newMessages.length - 1].entryId,
			text,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Search current summaries with default-tokenizer FTS5. Matches any extracted query term.
	 * Includes all indexed sessions, including the current session; does not scan original files.
	 *
	 * @returns At most topK hits, ascending BM25 score then session ID. Empty/invalid input or no match returns [].
	 * @throws SQLite errors. Extracted terms are quoted so user FTS operators cannot cause syntax errors.
	 */
	searchSummaries({ query, topK }: RetrievalQuery): RetrievalHit[] {
		const terms = query.match(/[\p{L}\p{N}_]+/gu);
		if (!terms?.length || !Number.isInteger(topK) || topK < 1) return [];
		// Quoted tokens prevent user text from becoming FTS operators; OR permits partial recall.
		const expression = terms.map((term) => `"${term}"`).join(" OR ");
		return this.db
			.prepare(`SELECT s.session_id, s.leaf_entry_id, s.content, s.timestamp,
			t.source_path, bm25(summaries_fts) AS score FROM summaries_fts
			JOIN summaries s ON s.rowid = summaries_fts.rowid JOIN sessions t ON t.id = s.session_id
			WHERE summaries_fts MATCH ? ORDER BY score, s.session_id LIMIT ?`)
			.all(expression, topK)
			.map((row) => ({
				text: String(row.content),
				score: Number(row.score),
				sourceType: "memory",
				sourceId: String(row.session_id),
				location: {
					entryId: String(row.leaf_entry_id),
					sourcePath: String(row.source_path),
					timestamp: String(row.timestamp),
				},
			}));
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
