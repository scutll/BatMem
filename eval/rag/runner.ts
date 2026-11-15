import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "../../src/db.ts";
import { RAGService } from "../../src/rag.ts";
import type { CorpusRecord, DatasetLoader, EvaluationQuery } from "./dataset.ts";

/** One corpus row becomes one indexed chunk. No Markdown scanning or chunking is performed. */
export interface RetrievalEvalOptions {
	loader: DatasetLoader;
	/** New directory, created exclusively; existing experiment files are never overwritten. */
	output: string;
	topK?: number;
}

/** Index prepared retrieval units through the production writer; reject duplicate source IDs. */
export async function indexCorpus(rag: RAGService, corpus: AsyncIterable<CorpusRecord>): Promise<Set<string>> {
	const ids = new Set<string>();
	for await (const record of corpus) {
		if (ids.has(record.id)) throw new Error(`Duplicate corpus ID: ${record.id}`);
		ids.add(record.id);
		const text = record.text;
		rag.replaceDocumentIndex(
			{
				id: record.id,
				// Logical source only: corpus records need not exist as separate files.
				sourcePath: `dataset:${record.id}`,
				contentHash: createHash("sha256").update(text).digest("hex"),
				modifiedAt: new Date(0).toISOString(),
			},
			[{ text, chunkIndex: 0, startLine: 1, endLine: Math.max(1, text.replace(/\n$/, "").split("\n").length) }],
		);
	}
	return ids;
}

/** Export every judged query in input order, including empty rankings; preserve native BM25 order. */
export async function exportResults(
	rag: RAGService,
	queries: EvaluationQuery[],
	topK: number,
	resultPath: string,
): Promise<void> {
	const file = await open(resultPath, "wx");
	try {
		for (const query of queries) {
			const hits = rag.searchChunks({ query: query.text, topK });
			await file.write(
				`${JSON.stringify({
					query_id: query.id,
					query: query.text,
					top_k: topK,
					hits: hits.map((hit, index) => ({
						document_id: hit.sourceId,
						rank: index + 1,
						score: hit.score,
						text: hit.text,
					})),
					qrels: query.qrels,
				})}\n`,
			);
		}
	} finally {
		await file.close();
	}
}

/**
 * Build a fresh isolated database, retrieve all judged queries and export ranked JSONL plus a manifest.
 * Errors abort the run; the manifest is written last and marks a complete export. Partial artifacts remain
 * for diagnosis. The production query preparation, BM25 ranking and FTS triggers are reused unchanged.
 */
export async function runRetrievalEval(options: RetrievalEvalOptions): Promise<void> {
	const topK = options.topK ?? 10;
	const loader = options.loader;
	if (!Number.isSafeInteger(topK) || topK < 1) throw new Error("topK must be a positive integer.");
	const output = resolve(options.output);
	const queries = await loader.loadQueries();
	if (!queries.length) throw new Error("No evaluation queries.");
	const queryIds = new Set<string>();
	for (const query of queries) {
		if (queryIds.has(query.id)) throw new Error(`Duplicate query ID: ${query.id}`);
		queryIds.add(query.id);
	}
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output, { recursive: false });
	const db = openDatabase(join(output, "index.db"));
	try {
		const rag = new RAGService(db, output);
		const ids = await indexCorpus(rag, loader.readCorpus());
		if (!ids.size) throw new Error("Empty corpus.");
		for (const query of queries) {
			for (const id of Object.keys(query.qrels)) {
				if (!ids.has(id)) throw new Error(`Qrel references missing corpus ID: ${id}`);
			}
		}
		await exportResults(rag, queries, topK, join(output, "retrieval.jsonl"));
		const hashes: Record<string, string> = {};
		for (const path of loader.sourceFiles) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			hashes[path] = hash.digest("hex");
		}
		// Fingerprint executable retrieval sources as well as data, including uncommitted changes.
		const implementationHashes: Record<string, string> = {};
		const implementations = ["../../src/db.ts", "../../src/rag.ts", "./dataset.ts", "./runner.ts"].map(
			(name) => new URL(name, import.meta.url),
		);
		for (const path of [...implementations, ...loader.implementationFiles]) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			implementationHashes[path.href] = hash.digest("hex");
		}
		await writeFile(
			join(output, "manifest.json"),
			JSON.stringify(
				{
					status: "complete",
					dataset: loader.name,
					split: loader.split,
					top_k: topK,
					corpus_count: ids.size,
					query_count: queries.length,
					input_sha256: hashes,
					implementation_sha256: implementationHashes,
					node_version: process.version,
					sqlite_version: db.prepare("SELECT sqlite_version() AS version").get()?.version,
					retriever: "SQLite FTS5 default tokenizer; quoted OR terms; native BM25 ascending",
					indexing: loader.indexing,
				},
				null,
				2,
			),
		);
	} finally {
		db.close();
	}
}
