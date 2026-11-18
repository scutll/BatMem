import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VectorIndex } from "../../src/embedding/vector-index.ts";
import { BM25Retriever } from "../../src/search/bm25.ts";
import { isSearchMode } from "../../src/search/modes.ts";
import { SearchService } from "../../src/search/service.ts";
import { VectorRetriever } from "../../src/search/vector.ts";
import { fingerprintCorpus, prepareCorpusBuild } from "./build.ts";
import type { EvaluationQuery } from "./dataset.ts";
import { Progress } from "./progress.ts";
import type { RetrievalEvalOptions, RetrievalFunction } from "./types.ts";
import { stripTypeScriptTypes } from "node:module";

export { indexCorpus } from "./build.ts";

/** Export every judged query in input order, including empty rankings; preserve retriever order. */
export async function exportResults(
	retrieve: RetrievalFunction,
	queries: EvaluationQuery[],
	topK: number,
	resultPath: string,
): Promise<void> {
	const file = await open(resultPath, "wx");
	const progress = new Progress("批量查询");
	let completed = 0;
	try {
		for (const query of queries) {
			progress.update(`${completed + 1}/${queries.length} 正在检索`);

			while (true) {
				try {

					// In case of some short Network Error Breaks the whole Eval,
					// continuously runs the retrieve until the network recovers
					const hits = await retrieve({ query: query.text, topK });
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
					progress.update(`${++completed}/${queries.length} 已完成`);

					break;
				} catch (error) {
					progress.update(`${completed + 1}/${queries.length} 检索错误,正在重试: ${error}`);
					continue;
				}
			}
		}
	} finally {
		progress.finish(`${completed}/${queries.length} 已导出`);
		await file.close();
	}
}

/**
 * Build or reuse the corpus index, then export an independent run with ranked JSONL and a manifest.
 * Errors abort the run; the manifest is written last and marks a complete export. Partial artifacts remain
 * for diagnosis. The production query preparation, BM25 ranking and FTS triggers are reused unchanged.
 */
export async function runRetrievalEval(options: RetrievalEvalOptions): Promise<void> {
	const topK = options.topK ?? 10;
	const mode = options.mode ?? "search";
	if (!isSearchMode(mode)) throw new Error("Unknown retrieval mode.");
	if (mode !== "search" && !options.embedding) throw new Error(`${mode} requires an embedding provider.`);
	const loader = options.loader;
	if (!Number.isSafeInteger(topK) || topK < 1) throw new Error("topK must be a positive integer.");
	const output = resolve(options.output);
	console.info(`[评测] 模式：${mode}；Top-K：${topK}；输出：${output}`);
	console.info("[查询集] 读取 Query / Qrels");
	const queries = await loader.loadQueries();
	if (!queries.length) throw new Error("No evaluation queries.");
	const queryIds = new Set<string>();
	for (const query of queries) {
		if (queryIds.has(query.id)) throw new Error(`Duplicate query ID: ${query.id}`);
		queryIds.add(query.id);
	}
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output, { recursive: false });
	const corpus = await fingerprintCorpus(loader);
	const buildDirectory = options.builds ? join(resolve(options.builds), corpus.fingerprint) : output;
	const build = await prepareCorpusBuild(loader, buildDirectory, corpus.fingerprint, corpus.count);
	const db = build.db;
	try {
		const hasDocument = db.prepare("SELECT 1 FROM documents WHERE id = ?");
		for (const query of queries) {
			for (const id of Object.keys(query.qrels)) {
				if (!hasDocument.get(id)) throw new Error(`Qrel references missing corpus ID: ${id}`);
			}
		}
		const vectors = mode !== "search" && options.embedding ? new VectorIndex(db, options.embedding) : undefined;
		if (vectors) {
			console.info(`[Embedding 模型] ${options.embedding!.identity}`);
			vectors.initialize();
			const status = vectors.getStatus("document");
			console.info(`[向量索引] 已有 ${status.indexed}/${status.total}；待生成 ${status.pending}`);
			if (status.pending) {
				const progress = new Progress("构建 Embedding");
				progress.update(`${status.indexed}/${status.total}；正在请求模型`);
				try {
					await vectors.syncEmbeddings("document", (current) => {
						progress.update(`${current.indexed}/${current.total}；剩余 ${current.pending}`);
					});
				} finally {
					const current = vectors.getStatus("document");
					progress.finish(`${current.indexed}/${current.total} 已保存；剩余 ${current.pending}`);
				}
			} else console.info("[向量索引] 完整复用，无需调用文档 embedding 模型");
			vectors.assertReady("document", options.embedding!);
			await writeFile(
				join(buildDirectory, "build-manifest.json"),
				JSON.stringify(
					{
						status: "vector-ready",
						corpus_fingerprint: build.fingerprint,
						corpus_count: build.count,
						index_path: build.path,
						embedding: { identity: options.embedding!.identity, dimensions: options.embedding!.dimensions },
						vector_status: vectors.getStatus("document"),
					},
					null,
					2,
				),
			);
		}
		const search = new SearchService(
			new BM25Retriever(db, "document"),
			vectors && options.embedding ? new VectorRetriever(vectors, options.embedding, "document") : undefined,
		);
		await exportResults(search[mode].bind(search), queries, topK, join(output, "retrieval.jsonl"));
		const hashes: Record<string, string> = {};
		for (const path of loader.sourceFiles) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			hashes[path] = hash.digest("hex");
		}
		// Fingerprint executable retrieval sources as well as data, including uncommitted changes.
		const implementationHashes: Record<string, string> = {};
		const implementations = [
			"../../src/storage/db.ts",
			"../../src/rag/service.ts",
			"../../src/rag/chunker.ts",
			"../../src/rag/types.ts",
			"../../src/embedding/provider.ts",
			"../../src/embedding/types.ts",
			"../../src/embedding/jina.ts",
			"../../src/embedding/vector-index.ts",
			"../../src/search/types.ts",
			"../../src/search/bm25.ts",
			"../../src/search/vector.ts",
			"../../src/search/service.ts",
			"../../src/search/recall.ts",
			"../../src/search/processor.ts",
			"../../src/search/bm25-embedding-recall.ts",
			"../../src/search/embedding-query-processor.ts",
			"../../src/search/modes.ts",
			"../../src/search/rows.ts",
			"./dataset.ts",
			"./types.ts",
			"./runner.ts",
			"./build.ts",
			"./progress.ts",
			"../../src/config.ts",
		].map((name) => new URL(name, import.meta.url));
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
					corpus_count: build.count,
					build: {
						directory: buildDirectory,
						index_path: build.path,
						fingerprint: build.fingerprint,
						reused: build.reused,
					},
					query_count: queries.length,
					input_sha256: hashes,
					implementation_sha256: implementationHashes,
					node_version: process.version,
					sqlite_version: db.prepare("SELECT sqlite_version() AS version").get()?.version,
					retriever: mode,
					queryPipeline:
						mode === "query" ? { recallPaths: ["bm25", "embedding"], processor: "rrf-rerank-blend" } : undefined,
					score:
						mode === "search"
							? "negated SQLite BM25; descending"
							: mode === "query"
								? "weighted reciprocal RRF rank and rerank score; descending"
							: "cosine similarity; descending",
					embedding: vectors
						? { identity: options.embedding!.identity, dimensions: options.embedding!.dimensions }
						: undefined,
					vector_status: vectors?.getStatus("document"),
					indexing: loader.indexing,
				},
				null,
				2,
			),
		);
		console.info(`[评测完成] ${queries.length} 条查询；结果：${join(output, "retrieval.jsonl")}`);
	} finally {
		build.close();
	}
}
