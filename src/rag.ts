import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chunkMarkdown } from "./chunker.ts";
import type { DocumentChunk, DocumentRecord, DocumentRetrievalHit, RetrievalQuery } from "./types.ts";

/** Local Markdown indexing and chunk retrieval. Source files are read, never modified. */
export class RAGService {
	private readonly db: DatabaseSync;
	private readonly documentsDirectory: string;
	/** Use a caller-owned initialized connection and one scan root; the root must exist when scanning. */
	constructor(db: DatabaseSync, documentsDirectory: string) {
		this.db = db;
		this.documentsDirectory = resolve(documentsDirectory);
	}

	/**
	 * Collect Markdown recursively, update changed files, then clean up deleted documents.
	 * Each file commits independently; the whole scan is not an atomic directory snapshot.
	 *
	 * @throws Traversal, file-read, or database errors. Earlier file updates remain committed on failure,
	 * but deletion cleanup runs only after every collected file was processed successfully.
	 * Callers must serialize scans for the same directory.
	 */
	async scanDocuments(ctx?: ExtensionContext): Promise<void> {
		const paths = await this.collectMarkdownFiles(this.documentsDirectory);
		if (ctx) {
			ctx.ui.notify("scanning and building index for Documents", "info");
		}
		for (const path of paths) await this.indexDocument(path);
		// An incomplete scan must never be interpreted as a set of deleted documents.
		this.removeDeletedDocuments(new Set(paths));
		ctx?.ui.notify("your agent is full of new power in brain!");
	}

	/** Hash content on every scan: size/mtime alone cannot detect same-size edits with restored timestamps. */
	async indexDocument(sourcePath: string): Promise<void> {
		const content = await readFile(sourcePath, "utf8");
		const metadata = await stat(sourcePath);
		const contentHash = createHash("sha256").update(content).digest("hex");
		const previous = this.getDocumentByPath(sourcePath);
		if (previous?.contentHash === contentHash) return;
		this.replaceDocumentIndex(
			{ id: previous?.id ?? randomUUID(), sourcePath, contentHash, modifiedAt: metadata.mtime.toISOString() },
			chunkMarkdown(content),
		);
	}

	/**
	 * Search current chunks with quoted OR terms, default-tokenizer FTS5 and native BM25 ranking.
	 * Does not scan disk; callers may await startup indexing before searching.
	 *
	 * @returns At most topK hits with path, chunk index and one-based inclusive line coordinates.
	 * Lowest scores rank first; ties use path and chunk index. Empty/invalid input or no match returns [].
	 */
	searchChunks({ query, topK }: RetrievalQuery): DocumentRetrievalHit[] {
		const terms = query.match(/[\p{L}\p{N}_]+/gu);
		if (!terms?.length || !Number.isInteger(topK) || topK < 1) return [];
		const expression = terms.map((term) => `"${term}"`).join(" OR ");
		return this.db
			.prepare(`SELECT c.*, d.id, d.source_path, bm25(chunks_fts) AS score FROM chunks_fts
			JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN documents d ON d.id = c.document_id
			WHERE chunks_fts MATCH ? ORDER BY score, d.source_path, c.chunk_index LIMIT ?`)
			.all(expression, topK)
			.map((row) => ({
				text: String(row.content),
				score: Number(row.score),
				sourceType: "document",
				sourceId: String(row.id),
				location: {
					sourcePath: String(row.source_path),
					chunkIndex: Number(row.chunk_index),
					startLine: Number(row.start_line),
					endLine: Number(row.end_line),
					section: row.section === null ? undefined : String(row.section),
				},
			}));
	}

	/** Collect sorted absolute .md paths, case-insensitively. Do not follow symlinks outside the scan root. */
	private async collectMarkdownFiles(directory: string): Promise<string[]> {
		const paths: string[] = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) paths.push(...(await this.collectMarkdownFiles(path)));
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) paths.push(path);
		}
		return paths.sort();
	}

	/** Retrieve identity/fingerprint so a changed document retains its existing ID. */
	private getDocumentByPath(sourcePath: string): DocumentRecord | undefined {
		const row = this.db.prepare("SELECT * FROM documents WHERE source_path = ?").get(sourcePath);
		return row
			? { id: String(row.id), sourcePath, contentHash: String(row.content_hash), modifiedAt: String(row.modified_at) }
			: undefined;
	}

	/**
	 * Replace a document and all its chunks atomically, maintaining FTS through database triggers.
	 * Accepts prepared chunks without reading or splitting files; BEIR can supply one whole-record chunk.
	 * @param document Stable identity and unique source path; an existing ID must retain its source path.
	 * @param chunks Complete replacement, with distinct numeric chunkIndex values. Empty removes all chunks.
	 * @throws Database errors roll back document/chunk changes together.
	 */
	replaceDocumentIndex(document: DocumentRecord, chunks: DocumentChunk[]): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(`INSERT INTO documents VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
				content_hash=excluded.content_hash, modified_at=excluded.modified_at`)
				.run(document.id, document.sourcePath, document.contentHash, document.modifiedAt);
			this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(document.id);
			const insert = this.db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)");
			for (const chunk of chunks)
				insert.run(document.id, chunk.chunkIndex, chunk.text, chunk.startLine, chunk.endLine, chunk.section ?? null);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Remove absent documents only inside this scan root; cascades/triggers remove their chunks and FTS entries. */
	private removeDeletedDocuments(existingPaths: Set<string>): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const remove = this.db.prepare("DELETE FROM documents WHERE id = ?");
			for (const row of this.db.prepare("SELECT id, source_path FROM documents").all()) {
				const path = String(row.source_path);
				const localPath = relative(this.documentsDirectory, path);
				if (
					localPath &&
					localPath !== ".." &&
					!localPath.startsWith(`..${sep}`) &&
					!isAbsolute(localPath) &&
					!existingPaths.has(path)
				)
					remove.run(row.id);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
