import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "../storage/database.ts";
import { createRetriever } from "../retrieval/create-retriever.ts";
import type { RetrievalOptions, RetrievalQuery, QueryRetriever } from "../retrieval/core/types.ts";
import { chunkMarkdown } from "./chunker.ts";
import type { DocumentChunk, DocumentRecord, DocumentRetrievalHit, RAGServiceOptions } from "./types.ts";

/** Local Markdown indexing and chunk retrieval. Source files are read, never modified. */
export class RAGService {
	private readonly db: Database;
	private readonly documentsDirectory: string;
	private readonly search: QueryRetriever;
	/** Use a caller-owned initialized connection and one scan root; the root must exist when scanning. */
	constructor(db: Database, documentsDirectory: string, options: RAGServiceOptions = {}) {
		this.db = db;
		this.documentsDirectory = resolve(documentsDirectory);
		this.search = options.search ?? createRetriever(db, "document");
	}

	/**
	 * Collect Markdown recursively, update changed files, then clean up deleted documents.
	 * Each file commits independently; the whole scan is not an atomic directory snapshot.
	 *
	 * @throws Traversal, file-read, or database errors. Earlier file updates remain committed on failure,
	 * but deletion cleanup runs only after every collected file was processed successfully.
	 * Callers must serialize scans for the same directory.
	 */
	async scanDocuments(): Promise<void> {
		const paths = await this.collectMarkdownFiles(this.documentsDirectory);
		for (const path of paths) await this.indexDocument(path);
		// An incomplete scan must never be interpreted as a set of deleted documents.
		this.removeDeletedDocuments(new Set(paths));
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

	/** Search indexed chunks with the caller's strategy; does not scan disk. */
	async searchChunks(request: RetrievalQuery, options: RetrievalOptions): Promise<DocumentRetrievalHit[]> {
		return (await this.search.retrieve(request, options)) as DocumentRetrievalHit[];
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
