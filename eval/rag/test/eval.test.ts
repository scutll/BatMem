import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { openDatabase } from "../../../src/storage/db.ts";
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
	await runRetrievalEval({ loader, output });
	const row = JSON.parse((await readFile(join(output, "retrieval.jsonl"), "utf8")).trim());
	assert.equal(row.hits[0].document_id, "custom-id");
	assert.equal(row.hits[0].text, "quasar\nexact prepared text");
	const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
	assert.equal(manifest.dataset, "custom-data");
	assert.deepEqual(manifest.input_sha256, {});
});

it("indexes whole records with original IDs and exports all judged queries, including no matches", async () => {
	await runRetrievalEval({ loader: new BeirDataset(dataset), output, topK: 2 });
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
	await assert.rejects(runRetrievalEval({ loader: new BeirDataset(dataset), output }), /EEXIST/);
});

it("rejects missing corpus evidence and leaves no completed manifest", async () => {
	await writeFile(join(dataset, "qrels", "test.tsv"), "query-id\tcorpus-id\tscore\nq1\tmissing\t1\n");
	await assert.rejects(runRetrievalEval({ loader: new BeirDataset(dataset), output }), /missing corpus ID/);
	await assert.rejects(readFile(join(output, "manifest.json")), /ENOENT/);
});

it("rejects duplicate corpus IDs rather than overwriting benchmark records", async () => {
	await writeFile(join(dataset, "corpus.jsonl"), '{"_id":"x","text":"a"}\n{"_id":"x","text":"b"}');
	await assert.rejects(runRetrievalEval({ loader: new BeirDataset(dataset), output }), /Duplicate corpus ID/);
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
