import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Open an index using BatMem's current tables, indexes, and triggers.
 * Original session/document files are never replaced by the index.
 *
 * @param dbPath File path (parent directories are created), or ":memory:" for an ephemeral database.
 * @returns Caller-owned connection; close it after all operations finish.
 * @throws Filesystem or SQLite/FTS5 initialization errors. Closes the connection if setup fails.
 */
export function openDatabase(dbPath: string): DatabaseSync {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath, { allowExtension: true });
	try {
		// Cascades clean up document chunks; WAL permits concurrent readers during writes.
		// The busy timeout tolerates brief contention between sessions sharing the project database.
		db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		createSchema(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/**
 * Create the current development schema.
 *
 * There is no versioned migration layer. Recreate an index database when the
 * schema changes incompatibly during development.
 */
function createSchema(db: DatabaseSync): void {
	db.exec(`
		BEGIN IMMEDIATE;
		-- One current summary per session; leaf_entry_id is its incremental processing position.
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
		-- Content-backed FTS uses SQLite's default tokenizer without language customization.
		CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(content, content='summaries', content_rowid='rowid');
		CREATE TRIGGER IF NOT EXISTS summaries_insert AFTER INSERT ON summaries BEGIN
			INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS summaries_delete AFTER DELETE ON summaries BEGIN
			INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
		END;
		CREATE TRIGGER IF NOT EXISTS summaries_update AFTER UPDATE OF content ON summaries BEGIN
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
		CREATE TABLE IF NOT EXISTS embedding_config (
			id INTEGER PRIMARY KEY CHECK(id = 1), identity TEXT NOT NULL, dimensions INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS embeddings (
			source_type TEXT NOT NULL, unit_id INTEGER NOT NULL, vector BLOB NOT NULL,
			PRIMARY KEY(source_type, unit_id)
		);
		CREATE VIEW IF NOT EXISTS retrieval_units AS
			SELECT 'document' AS source_type, c.rowid AS unit_id, c.document_id AS source_id,
				c.content, d.source_path, c.chunk_index, c.start_line, c.end_line, c.section,
				NULL AS entry_id, NULL AS timestamp
			FROM chunks c JOIN documents d ON d.id = c.document_id
			UNION ALL
			SELECT 'memory', s.rowid, s.session_id, s.content, t.source_path,
				NULL, NULL, NULL, NULL, s.leaf_entry_id, s.timestamp
			FROM summaries s JOIN sessions t ON t.id = s.session_id;
		CREATE TRIGGER IF NOT EXISTS chunks_vector_delete AFTER DELETE ON chunks BEGIN
			DELETE FROM embeddings WHERE source_type = 'document' AND unit_id = old.rowid;
		END;
		CREATE TRIGGER IF NOT EXISTS chunks_vector_update AFTER UPDATE OF content ON chunks BEGIN
			DELETE FROM embeddings WHERE source_type = 'document' AND unit_id = old.rowid;
		END;
		CREATE TRIGGER IF NOT EXISTS chunks_update AFTER UPDATE OF content ON chunks BEGIN
			INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
			INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
		END;
		CREATE TRIGGER IF NOT EXISTS summaries_vector_delete AFTER DELETE ON summaries BEGIN
			DELETE FROM embeddings WHERE source_type = 'memory' AND unit_id = old.rowid;
		END;
		CREATE TRIGGER IF NOT EXISTS summaries_vector_update AFTER UPDATE OF content ON summaries BEGIN
			DELETE FROM embeddings WHERE source_type = 'memory' AND unit_id = old.rowid;
		END;
		COMMIT;
	`);
}
