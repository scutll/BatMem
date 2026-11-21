import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VectorIndex } from "../../../src/storage/vector-index.ts";
import { createRetriever } from "../../../src/retrieval/create-retriever.ts";
import { fingerprintCorpus, prepareCorpusBuild } from "./build.ts";
import type { EvaluationQuery } from "../datasets/types.ts";
import { Progress } from "./progress.ts";
import type { RetrievalEvalOptions, RetrievalFunction } from "./types.ts";

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
	const selected = options.retrieval;
	const embedding = options.embedding;
	if (selected.requiresEmbedding && !options.embedding)
		throw new Error(`${selected.id} requires an embedding provider.`);
	const loader = options.loader;
	if (!Number.isSafeInteger(topK) || topK < 1) throw new Error("topK must be a positive integer.");
	const output = resolve(options.output);
	console.info(`[评测] 策略：${selected.id}；Top-K：${topK}；输出：${output}`);
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
		const vectors = selected.requiresEmbedding && embedding ? new VectorIndex(db, embedding) : undefined;
		if (vectors && embedding) {
			console.info(`[Embedding 模型] ${embedding.identity}`);
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
			vectors.assertReady("document", embedding);
			await writeFile(
				join(buildDirectory, "build-manifest.json"),
				JSON.stringify(
					{
						status: "vector-ready",
						corpus_fingerprint: build.fingerprint,
						corpus_count: build.count,
						index_path: build.path,
						embedding: { identity: embedding.identity, dimensions: embedding.dimensions },
						vector_status: vectors.getStatus("document"),
					},
					null,
					2,
				),
			);
		}
		const search = createRetriever(db, "document", options.embedding, options.reranking);
		await exportResults(
			(request) => search.retrieve(request, selected),
			queries,
			topK,
			join(output, "retrieval.jsonl"),
		);
		const hashes: Record<string, string> = {};
		for (const path of loader.sourceFiles) {
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			hashes[path] = hash.digest("hex");
		}
		// Fingerprint executable retrieval sources as well as data, including uncommitted changes.
		const implementationHashes: Record<string, string> = {};
		const implementations = [
			"../../../src/storage/database.ts",
			"../../../src/storage/query-executor.ts",
			"../../../src/storage/query-executor-types.ts",
			"../../../src/storage/query-worker.ts",
			"../../../src/documents/service.ts",
			"../../../src/documents/chunker.ts",
			"../../../src/documents/types.ts",
			"../../../src/models/embedding/provider.ts",
			"../../../src/models/embedding/types.ts",
			"../../../src/models/embedding/jina.ts",
			"../../../src/storage/vector-index.ts",
			"../../../src/retrieval/core/types.ts",
			"../../../src/retrieval/recall/utils/bm25.ts",
			"../../../src/retrieval/recall/utils/vector.ts",
			"../../../src/retrieval/core/retriever.ts",
			"../../../src/retrieval/create-retriever.ts",
			"../../../src/retrieval/strategies/registry.ts",
			"../../../src/retrieval/strategies/presets.ts",
			"../../../src/storage/vector-types.ts",
			"../../../src/retrieval/strategies/multi-bm25.ts",
			"../../../src/retrieval/strategies/multi-bm25-embedding.ts",
			"../../../src/models/completion/completion.ts",
			"../../../src/models/completion/deepseek.ts",
			"../../../src/models/completion/types.ts",
			"../../../src/extension/register.ts",
			"../../../src/retrieval/recall/parallel.ts",
			"../../../src/retrieval/processors/passthrough.ts",
			"../../../src/models/reranking/provider.ts",
			"../../../src/models/reranking/jina.ts",
			"../../../src/models/reranking/types.ts",
			"../../../src/retrieval/core/recall.ts",
			"../../../src/retrieval/core/processor.ts",
			"../../../src/retrieval/recall/bm25-embedding.ts",
			"../../../src/retrieval/processors/rrf-rerank-blend.ts",
			"../../../src/storage/retrieval-row.ts",
			"../datasets/types.ts",
			"./types.ts",
			"./runner.ts",
			"./build.ts",
			"./progress.ts",
			"../../../src/models/create-providers.ts",
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
					retriever: selected.id,
					queryPipeline: selected.metadata
						? { recallPaths: selected.metadata.recallPaths, processor: selected.metadata.processor }
						: undefined,
					score: selected.metadata?.score,
					reranking: options.reranking?.identity,
					embedding:
						vectors && embedding ? { identity: embedding.identity, dimensions: embedding.dimensions } : undefined,
					vector_status: vectors?.getStatus("document"),
					indexing: loader.indexing,
				},
				null,
				2,
			),
		);
		console.info(`[评测完成] ${queries.length} 条查询；结果：${join(output, "retrieval.jsonl")}`);
	} finally {
		await build.close();
	}
}
