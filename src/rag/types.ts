import type { RetrievalHit, RetrievalService } from "../search/types.ts";

export interface RAGServiceOptions {
	search?: RetrievalService;
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
