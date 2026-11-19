import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import type { EmbeddingProvider } from "../../../src/embedding/provider.ts";
import { ParallelRecall } from "../../../src/search/parallel-recall.ts";
import { BM25_RECALL, EMBEDDING_RECALL } from "../../../src/search/strategies.ts";
import type { RetrievalOptions } from "../../../src/search/types.ts";
import { openDatabase } from "../../../src/storage/db.ts";
import { OFFLINE_HYBRID_OPTIONS } from "../../../test/helpers/reranking.ts";
import { BeirDataset, loadQueries } from "../beir.ts";
import type { DatasetLoader } from "../dataset.ts";
import { runRetrievalEval } from "../runner.ts";

let root: string;
let dataset: string;
let output: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "batmem-eval-"));
	dataset = join(root, "dataset");
	output = join(root, "run");
	await mkdir(join(dataset, "qrels"), { recursive: true });
	await writeFile(
		join(dataset, "corpus.jsonl"),
		[
			{ _id: "doc/string-1", title: "quasar", text: "background ".repeat(100) },
			{ _id: "d2", text: "transactions" },
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	await writeFile(
		join(dataset, "queries.jsonl"),
		[
			{ _id: "q1", text: "quasar" },
			{ _id: "q2", text: "absenttoken" },
			{ _id: "unused", text: "unused" },
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	await writeFile(
		join(dataset, "qrels", "test.tsv"),
		"query-id\tcorpus-id\tscore\r\nq1\tdoc/string-1\t2\r\nq2\td2\t1\r\n",
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("runs an in-memory adapter without BEIR files or title preparation in the runner", async () => {
	await rm(dataset, { recursive: true });
	const loader: DatasetLoader = {
		name: "custom-data",
		split: "all",
		indexing: "prepared text",
		sourceFiles: [],
		implementationFiles: [],
		async *readCorpus() {
			yield { id: "custom-id", text: "quasar\nexact prepared text" };
		},
		async loadQueries() {
			return [{ id: "custom-query", text: "quasar", qrels: { "custom-id": 1 } }];
		},
	};
	await runRetrievalEval({ loader, output, retrieval: BM25_RECALL });
	const row = JSON.parse((await readFile(join(output, "retrieval.jsonl"), "utf8")).trim());
	assert.equal(row.hits[0].document_id, "custom-id");
	assert.equal(row.hits[0].text, "quasar\nexact prepared text");
	const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
	assert.equal(manifest.dataset, "custom-data");
	assert.deepEqual(manifest.input_sha256, {});
});

it("indexes whole records with original IDs and exports all judged queries, including no matches", async () => {
	await runRetrievalEval({ retrieval: BM25_RECALL, loader: new BeirDataset(dataset), output, topK: 2 });
	const rows = (await readFile(join(output, "retrieval.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(rows.length, 2);
	assert.equal(rows[0].hits[0].document_id, "doc/string-1");
	assert.ok(rows[0].hits[0].text.length > 500, "BEIR records must not be split");
	assert.equal(rows[0].qrels["doc/string-1"], 2);
	assert.deepEqual(rows[1].hits, []);
	const db = openDatabase(join(output, "index.db"));
	try {
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()?.n, 2);
	} finally {
		db.close();
	}
	const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
	assert.equal(manifest.query_count, 2);
	assert.equal(Object.keys(manifest.input_sha256).length, 3);
	await assert.rejects(
		runRetrievalEval({ retrieval: BM25_RECALL, loader: new BeirDataset(dataset), output }),
		/EEXIST/,
	);
});

it("rejects missing corpus evidence and leaves no completed manifest", async () => {
	await writeFile(join(dataset, "qrels", "test.tsv"), "query-id\tcorpus-id\tscore\nq1\tmissing\t1\n");
	await assert.rejects(
		runRetrievalEval({ retrieval: BM25_RECALL, loader: new BeirDataset(dataset), output }),
		/missing corpus ID/,
	);
	await assert.rejects(readFile(join(output, "manifest.json")), /ENOENT/);
});

it("rejects duplicate corpus IDs rather than overwriting benchmark records", async () => {
	await writeFile(join(dataset, "corpus.jsonl"), '{"_id":"x","text":"a"}\n{"_id":"x","text":"b"}');
	await assert.rejects(
		runRetrievalEval({ retrieval: BM25_RECALL, loader: new BeirDataset(dataset), output }),
		/Duplicate corpus ID/,
	);
});

it("rejects invalid records, unknown query references and duplicate judgments", async () => {
	const queries = join(dataset, "queries.jsonl");
	const qrels = join(dataset, "qrels", "test.tsv");
	await writeFile(qrels, "query-id\tcorpus-id\tscore\nunknown\td2\t1\n");
	await assert.rejects(loadQueries(queries, qrels), /Unknown query/);
	await writeFile(qrels, "query-id\tcorpus-id\tscore\nq1\td2\t1\nq1\td2\t0\n");
	await assert.rejects(loadQueries(queries, qrels), /Duplicate qrel/);
	await writeFile(queries, '{"_id":42,"text":"invalid"}');
	await assert.rejects(loadQueries(queries, qrels), /queries.jsonl:1/);
});

it("query reuses vector builds and exports fused rankings with explicit pipeline metadata", async () => {
	let encoded = 0;
	let queries = 0;
	const embedding: EmbeddingProvider = {
		identity: "test/beir-query:v1",
		dimensions: 2,
		async embedDocuments(texts) {
			encoded += texts.length;
			return texts.map((text) => (text === "transactions" ? [1, 0] : [0, 1]));
		},
		async embedQuery() {
			queries++;
			return [1, 0];
		},
	};
	const builds = join(root, "builds");
	const baseline = join(root, "bm25");
	const vectorRun = join(root, "vector");
	const loader = new BeirDataset(dataset);
	await runRetrievalEval({ loader, output: baseline, builds, topK: 2, retrieval: BM25_RECALL });
	await runRetrievalEval({ loader, output: vectorRun, builds, topK: 2, retrieval: EMBEDDING_RECALL, embedding });
	await runRetrievalEval({ loader, output, builds, topK: 2, retrieval: OFFLINE_HYBRID_OPTIONS, embedding });
	assert.equal(encoded, 2);
	assert.equal(queries, 4);
	const text = await readFile(join(output, "retrieval.jsonl"), "utf8");
	const rows = text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		rows[0].hits.map((hit: { document_id: string }) => hit.document_id),
		["doc/string-1", "d2"],
	);
	assert.deepEqual(
		rows[1].hits.map((hit: { document_id: string }) => hit.document_id),
		["d2", "doc/string-1"],
	);
	assert.deepEqual(
		rows.map((row) => row.hits.map((hit: { score: number }) => hit.score)),
		[
			[0.75, 0.375],
			[0.75, 0.375],
		],
	);
	assert.notEqual(text, await readFile(join(vectorRun, "retrieval.jsonl"), "utf8"));
	assert.notEqual(text, await readFile(join(baseline, "retrieval.jsonl"), "utf8"));
	const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
	const lexicalManifest = JSON.parse(await readFile(join(baseline, "manifest.json"), "utf8"));
	assert.equal(manifest.build.fingerprint, lexicalManifest.build.fingerprint);
	assert.equal(manifest.build.reused, true);
	assert.equal(manifest.retriever, "query");
	assert.deepEqual(manifest.queryPipeline, { recallPaths: ["bm25", "embedding"], processor: "rrf-rerank-blend" });
	assert.match(manifest.score, /RRF rank.*rerank/);
	assert.ok(Object.keys(manifest.implementation_sha256).some((name) => name.endsWith("/search/recall.ts")));
	assert.ok(
		Object.keys(manifest.implementation_sha256).some((name) => name.endsWith("/search/bm25-embedding-recall.ts")),
	);
	assert.ok(
		Object.keys(manifest.implementation_sha256).some((name) => name.endsWith("/search/embedding-query-processor.ts")),
	);

	const recoveredRun = join(root, "recovered-query");
	let attempts = 0;
	await runRetrievalEval({
		loader,
		output: recoveredRun,
		builds,
		retrieval: OFFLINE_HYBRID_OPTIONS,
		embedding: {
			...embedding,
			async embedQuery() {
				if (++attempts === 1) throw new Error("query embedding unavailable");
				return [1, 0];
			},
		},
	});
	assert.equal(attempts, 3);
	assert.equal(JSON.parse(await readFile(join(recoveredRun, "manifest.json"), "utf8")).status, "complete");
	assert.equal(encoded, 2);
	await assert.rejects(
		runRetrievalEval({ loader, output: join(root, "missing-provider"), retrieval: OFFLINE_HYBRID_OPTIONS }),
		/requires an embedding provider/,
	);
});

it("runs custom lexical options without embeddings and records their metadata", async () => {
	const selected: RetrievalOptions = {
		...BM25_RECALL,
		id: "expanded-lexical",
		metadata: { recallPaths: ["rewritten"], processor: "passthrough", score: "BM25 after query rewrite" },
		createRecall: ({ bm25 }) =>
			new ParallelRecall([
				{
					path: "rewritten",
					run: async (request) => bm25.retrieve({ ...request, query: "transactions" }),
				},
			]),
	};
	await runRetrievalEval({ loader: new BeirDataset(dataset), output, retrieval: selected });
	const rows = (await readFile(join(output, "retrieval.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(rows.every((row) => row.hits[0].document_id === "d2"));
	const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
	assert.equal(manifest.retriever, selected.id);
	assert.deepEqual(manifest.queryPipeline, { recallPaths: ["rewritten"], processor: "passthrough" });
	assert.equal(manifest.score, selected.metadata?.score);
	assert.equal(manifest.embedding, undefined);
});
