import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Open an index and initialize missing tables, FTS indexes, and triggers.
 * Original session/document files are never replaced by the index.
 *
 * @param dbPath File path (parent directories are created), or ":memory:" for an ephemeral database.
 * @returns Caller-owned connection; close it after all operations finish.
 * @throws Filesystem or SQLite/FTS5 initialization errors. Closes the connection if setup fails.
 */
export function openDatabase(dbPath: string): DatabaseSync {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		// Cascades clean up document chunks; WAL permits concurrent readers during writes.
		// The busy timeout tolerates brief contention between sessions sharing the project database.
		db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		initializeSchema(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/** Create the initial schema idempotently; does not migrate incompatible existing schemas. */
function initializeSchema(db: DatabaseSync): void {
	// One current summary per session; leaf_entry_id is its incremental processing position.
	// Content-backed FTS tables use SQLite's default tokenizer without language-specific customization.
	// FTS triggers keep replacement/deletion atomic with the corresponding content rows.
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY, source_path TEXT NOT NULL, project_path TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS messages (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			entry_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
			PRIMARY KEY(session_id, entry_id)
		);
		CREATE TABLE IF NOT EXISTS summaries (
			session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
			leaf_entry_id TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
			UNIQUE(session_id, leaf_entry_id)
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(content, content='summaries', content_rowid='rowid');
		CREATE TRIGGER IF NOT EXISTS summaries_insert AFTER INSERT ON summaries BEGIN
			INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS summaries_delete AFTER DELETE ON summaries BEGIN
			INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS summaries_update AFTER UPDATE ON summaries BEGIN
			INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL,
			modified_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS chunks (
			document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
			chunk_index INTEGER NOT NULL, content TEXT NOT NULL, start_line INTEGER NOT NULL,
			end_line INTEGER NOT NULL, section TEXT,
			UNIQUE(document_id, chunk_index)
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='rowid');
		CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
			INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
			INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
		END;
	`);
}
