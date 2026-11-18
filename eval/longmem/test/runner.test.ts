import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import type { EmbeddingProvider } from "../../../src/embedding/provider.ts";
import { VectorIndex } from "../../../src/embedding/vector-index.ts";
import { MemoryService } from "../../../src/memory/service.ts";
import { openDatabase } from "../../../src/storage/db.ts";
import { LongMemEvalDataset, parseSample } from "../longmemeval.ts";
import {
	buildMemory,
	buildMemoryVectors,
	createEvaluationRun,
	loadPreparedSample,
	prepareBuild,
	prepareMemoryBuild,
	prepareSample,
	reconcileMemoryBuild,
	runMemoryEval,
} from "../runner.ts";
import type { MemoryBuildConfig, PreparedBuild } from "../types.ts";

let root: string;
let input: string;
let output: string;
const config: MemoryBuildConfig = {
	model: "mock/summary",
	summaryPromptSha256: "prompt-hash",
	syncMode: "session-final",
};
const source = {
	question_id: "q1",
	question_type: "single-session-user",
	question: "What is my pet?",
	question_date: "2023/05/30 (Tue) 23:40",
	answer: "REFERENCE_SECRET",
	answer_session_ids: ["answer_id"],
	haystack_session_ids: ["answer_id"],
	haystack_dates: ["2023/05/20 (Sat) 02:21"],
	haystack_sessions: [
		[
			{ role: "user", content: 'quasar pet is a cat; escaped } and " quote', has_answer: true },
			{ role: "assistant", content: "Noted" },
		],
	],
};
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "batmem-longmem-"));
	input = join(root, "input.json");
	output = join(root, "run");
	await writeFile(input, JSON.stringify([source]));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function prepareRun(types: string[] = [], limit = 1): Promise<PreparedBuild> {
	const build = await prepareBuild(new LongMemEvalDataset(input), join(root, "builds"), { limit, types }, config);
	await createEvaluationRun(output, build);
	return build;
}

it("streams and validates samples while removing answer labels from history projections", async () => {
	const rows = [];
	for await (const row of new LongMemEvalDataset(input).readSamples()) rows.push(row);
	assert.equal(rows.length, 1);
	assert.equal(JSON.stringify(rows[0].histories).includes("has_answer"), false);
	assert.equal(rows[0].reference.answer, "REFERENCE_SECRET");
	assert.equal(parseSample({ ...source, answer: 3 }).reference.answer, "3");
	assert.throws(() => parseSample({ ...source, answer: null }), /Invalid answer/);
	assert.throws(() => parseSample({ ...source, haystack_dates: [] }), /history arrays/);
	await writeFile(input, `${JSON.stringify([source]).slice(0, -1)},]`);
	await assert.rejects(async () => {
		for await (const _row of new LongMemEvalDataset(input).readSamples()) {
			/* consume */
		}
	}, /framing/);
	await writeFile(input, JSON.stringify([source, source]));
	await assert.rejects(async () => {
		for await (const _row of new LongMemEvalDataset(input).readSamples()) {
			/* consume */
		}
	}, /Duplicate question/);
});

it("filters selected question types before applying the sample limit", async () => {
	await writeFile(input, JSON.stringify([source, { ...source, question_id: "q2", question_type: "multi-session" }]));
	const build = await prepareRun(["multi-session"]);
	const prepared = await loadPreparedSample(build.directory, build.manifest.sampleDirectories[0]);
	assert.equal(prepared.sample.id, "q2");
	assert.equal(prepared.sample.type, "multi-session");
});

it("reuses a build prefix when limit shrinks and appends only new samples when it grows", async () => {
	await writeFile(input, JSON.stringify([source, { ...source, question_id: "q2" }, { ...source, question_id: "q3" }]));
	const builds = join(root, "builds");
	const first = await prepareBuild(new LongMemEvalDataset(input), builds, { limit: 1, types: [] }, config);
	const samples = [];
	for await (const sample of new LongMemEvalDataset(input).readSamples()) samples.push(sample);
	// Simulate a process stopping after the next sample file has been written but before manifest publication.
	await prepareSample(samples[1], join(first.directory, "samples", "0002"));
	const expanded = await prepareBuild(new LongMemEvalDataset(input), builds, { limit: 3, types: [] }, config);
	const reduced = await prepareBuild(new LongMemEvalDataset(input), builds, { limit: 2, types: [] }, config);
	assert.equal(expanded.directory, first.directory);
	assert.equal(reduced.directory, first.directory);
	assert.equal(first.sampleDirectories.length, 1);
	assert.equal(expanded.sampleDirectories.length, 3);
	assert.equal(reduced.sampleDirectories.length, 2);
	assert.equal(expanded.manifest.sampleDirectories.length, 3);
});

it("reuses an identical build cache and assigns repeated source sessions independent Pi identities", async () => {
	await writeFile(
		input,
		JSON.stringify([
			{
				...source,
				haystack_session_ids: ["answer_id", "answer_id"],
				haystack_dates: [source.haystack_dates[0], "2023/05/29 (Mon) 13:56"],
				haystack_sessions: [source.haystack_sessions[0], source.haystack_sessions[0]],
			},
		]),
	);
	const build = await prepareRun();
	const reused = await prepareBuild(
		new LongMemEvalDataset(input),
		join(root, "builds"),
		{ limit: 1, types: [] },
		config,
	);
	assert.equal(reused.directory, build.directory);
	const prepared = await loadPreparedSample(build.directory, build.manifest.sampleDirectories[0]);
	assert.equal(prepared.sample.histories.length, 2);
	assert.deepEqual(
		prepared.sessions.map((session) => session.originalId),
		["answer_id", "answer_id"],
	);
	assert.equal(new Set(prepared.sessions.map((session) => session.sessionId)).size, 2);
	assert.equal(new Set(prepared.sessions.map((session) => session.path)).size, 2);
});

it("builds searchable SQLite memory and writes answer artifacts only to the run directory", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.manifest.sampleDirectories[0]);
	let calls = 0;
	await buildMemory(prepared, async (text) => {
		calls++;
		assert.ok(!text.includes(source.question));
		assert.ok(!text.includes("REFERENCE_SECRET"));
		assert.ok(!text.includes("has_answer"));
		return "quasar pet cat";
	});
	assert.equal(calls, 1);
	const db = openDatabase(join(prepared.project, ".pi", "docs-memory", "index.db"));
	try {
		assert.equal((await new MemoryService(db).searchSummaries({ query: "quasar", topK: 1 })).length, 1);
	} finally {
		db.close();
	}
	await writeFile(join(prepared.directory, "memory-ready.json"), JSON.stringify(config));
	await runMemoryEval(output, build, async ({ project, runtimeDirectory, question, date, trace }) => {
		assert.equal(project, join(output, build.manifest.sampleDirectories[0], "project"));
		assert.equal(runtimeDirectory, join(output, build.manifest.sampleDirectories[0]));
		assert.equal(question, source.question);
		assert.equal(date, source.question_date);
		trace.push({ type: "mock", data: "evidence" });
		return { text: "cat", usage: [], elapsedMs: 1 };
	});
	assert.equal(JSON.parse((await readFile(join(output, "answers-memory.jsonl"), "utf8")).trim()).hypothesis, "cat");
	await assert.rejects(readFile(join(prepared.directory, "answer-memory.json")), /ENOENT/);
	assert.equal(JSON.parse(await readFile(join(output, "samples", "0001", "answer-memory.json"), "utf8")).text, "cat");
});

it("reuses a summary build across search and vsearch and resumes failed vector batches", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.sampleDirectories[0]);
	let summaries = 0;
	await buildMemory(prepared, async () => {
		summaries++;
		return "quasar pet cat";
	});
	await writeFile(join(prepared.directory, "memory-ready.json"), JSON.stringify(config));
	const reused = await prepareBuild(
		new LongMemEvalDataset(input),
		join(root, "builds"),
		{ limit: 1, types: [] },
		config,
	);
	assert.equal(reused.directory, build.directory);
	assert.equal(await prepareMemoryBuild(prepared, JSON.stringify(config)), false);

	let fail = true;
	const encoded: string[] = [];
	const embedding: EmbeddingProvider = {
		identity: "test/longmem-2d:v1",
		dimensions: 2,
		async embedDocuments(texts) {
			encoded.push(...texts);
			if (fail) throw new Error("embedding unavailable");
			return texts.map(() => [1, 0]);
		},
		async embedQuery() {
			return [1, 0];
		},
	};
	const incompleteRun = join(root, "incomplete-vector-run");
	await createEvaluationRun(incompleteRun, reused, "vsearch", embedding);
	let answered = false;
	await assert.rejects(
		runMemoryEval(
			incompleteRun,
			reused,
			async () => {
				answered = true;
				return { text: "cat", usage: [], elapsedMs: 1 };
			},
			"memory",
			"vsearch",
			embedding,
		),
		/questions failed/,
	);
	assert.equal(answered, false);
	await assert.rejects(buildMemoryVectors(prepared, embedding), /embedding unavailable/);
	fail = false;
	await buildMemoryVectors(prepared, embedding);
	assert.deepEqual(encoded, ["quasar pet cat", "quasar pet cat"]);
	assert.equal(summaries, 1);

	const vectorRun = join(root, "vector-run");
	const manifest = await createEvaluationRun(vectorRun, reused, "vsearch", embedding);
	assert.equal(manifest.retrieval, "vsearch");
	assert.equal(manifest.embedding?.identity, embedding.identity);
	await runMemoryEval(
		vectorRun,
		reused,
		async () => ({ text: "cat", usage: [], elapsedMs: 1 }),
		"memory",
		"vsearch",
		embedding,
	);
	assert.match(await readFile(join(vectorRun, "answers-memory.jsonl"), "utf8"), /"cat"/);
});

it("query reuses summaries and vectors and rejects incomplete indexes before answering", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.sampleDirectories[0]);
	let summaries = 0;
	let encoded = 0;
	const embedding: EmbeddingProvider = {
		identity: "test/longmem-query:v1",
		dimensions: 2,
		async embedDocuments(texts) {
			encoded += texts.length;
			return texts.map(() => [1, 0]);
		},
		async embedQuery() {
			return [1, 0];
		},
	};
	await buildMemory(prepared, async () => {
		summaries++;
		return "pet cat";
	});
	await writeFile(join(prepared.directory, "memory-ready.json"), JSON.stringify(config));
	await assert.rejects(
		createEvaluationRun(join(root, "no-provider"), build, "query"),
		/requires an embedding provider/,
	);
	const incompleteRun = join(root, "incomplete-query");
	await createEvaluationRun(incompleteRun, build, "query", embedding);
	let answered = false;
	const answer = async () => {
		answered = true;
		return { text: "cat", usage: [], elapsedMs: 1 };
	};
	await assert.rejects(runMemoryEval(incompleteRun, build, answer, "memory", "query", embedding), /questions failed/);
	assert.equal(answered, false);
	await buildMemoryVectors(prepared, embedding);
	await buildMemoryVectors(prepared, embedding);
	assert.equal(encoded, 1);
	assert.equal(summaries, 1);
	assert.equal(await prepareMemoryBuild(prepared, JSON.stringify(config)), false);
	const queryRun = join(root, "complete-query");
	const manifest = await createEvaluationRun(queryRun, build, "query", embedding);
	assert.equal(manifest.buildFingerprint, build.manifest.fingerprint);
	assert.deepEqual(manifest.queryPipeline, { recallPaths: ["bm25", "embedding"], processor: "embedding-passthrough" });
	assert.ok(manifest.codeSha256?.["../../src/search/recall.ts"]);
	assert.ok(manifest.codeSha256["../../src/search/bm25-embedding-recall.ts"]);
	assert.ok(manifest.codeSha256["../../src/search/embedding-query-processor.ts"]);
	const sourcePath = join(prepared.project, ".pi", "docs-memory", "index.db");
	const before = await readFile(sourcePath);
	await runMemoryEval(queryRun, build, answer, "memory", "query", embedding);
	assert.equal(answered, true);
	assert.deepEqual(await readFile(sourcePath), before);
	assert.match(await readFile(join(queryRun, "answers-memory.jsonl"), "utf8"), /cat/);
});

it("rejects old answer sessions in a build and removes only those sessions during repair", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.manifest.sampleDirectories[0]);
	await buildMemory(prepared, async () => "quasar pet cat");
	await writeFile(join(prepared.directory, "memory-ready.json"), JSON.stringify(config));
	const dbPath = join(prepared.project, ".pi", "docs-memory", "index.db");
	const db = openDatabase(dbPath);
	try {
		db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("old-answer", "old-answer.jsonl", prepared.project);
		db.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?)").run("old-answer", "entry", "leaked answer", "2023-05-30");
		await new VectorIndex(db, {
			identity: "test/cleanup-2d:v1",
			dimensions: 2,
			async embedDocuments(texts) {
				return texts.map(() => [1, 0]);
			},
			async embedQuery() {
				return [1, 0];
			},
		}).syncEmbeddings("memory");
	} finally {
		db.close();
	}
	let answered = false;
	await assert.rejects(
		runMemoryEval(output, build, async () => {
			answered = true;
			return { text: "cat", usage: [], elapsedMs: 1 };
		}),
		/questions failed/,
	);
	assert.equal(answered, false);
	assert.equal(reconcileMemoryBuild(prepared, true), 1);
	assert.equal(reconcileMemoryBuild(prepared, false), 0);
	const verified = openDatabase(dbPath);
	try {
		assert.deepEqual(
			verified
				.prepare("SELECT id FROM sessions")
				.all()
				.map((row) => row.id),
			[prepared.sessions[0].sessionId],
		);
		assert.equal(verified.prepare("SELECT COUNT(*) AS n FROM summaries").get()?.n, 1);
		assert.equal(verified.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE source_type = 'memory'").get()?.n, 1);
	} finally {
		verified.close();
	}
});

it("rejects a ready build when an imported history has no summary", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.sampleDirectories[0]);
	await buildMemory(prepared, async () => "quasar pet cat");
	const db = openDatabase(join(prepared.project, ".pi", "docs-memory", "index.db"));
	try {
		db.prepare("DELETE FROM summaries WHERE session_id = ?").run(prepared.sessions[0].sessionId);
	} finally {
		db.close();
	}
	assert.throws(() => reconcileMemoryBuild(prepared, false), /missing 1 historical summaries/);
	assert.throws(() => reconcileMemoryBuild(prepared, true), /missing 1 historical summaries/);
});

it("answers without creating a build lock or backup", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.sampleDirectories[0]);
	await buildMemory(prepared, async () => "quasar pet cat");
	await writeFile(join(prepared.directory, "memory-ready.json"), JSON.stringify(config));
	const dbPath = join(prepared.project, ".pi", "docs-memory", "index.db");
	const before = await readFile(dbPath);
	await runMemoryEval(output, build, async () => ({ text: "cat", usage: [], elapsedMs: 1 }));
	assert.match(await readFile(join(output, "answers-memory.jsonl"), "utf8"), /"cat"/);
	assert.deepEqual(await readFile(dbPath), before);
	assert.ok((await readFile(join(output, "samples", "0001", "project", ".pi", "docs-memory", "index.db"))).length > 0);
	await assert.rejects(readFile(join(prepared.directory, ".answer.lock")), /ENOENT/);
	await assert.rejects(readFile(join(output, "samples", "0001", ".memory-backup", "index.db")), /ENOENT/);
});

it("records question failures instead of judging partial answers", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.manifest.sampleDirectories[0]);
	await assert.rejects(
		buildMemory(prepared, async () => {
			throw new Error("Model unavailable");
		}),
		/unavailable/,
	);
	await assert.rejects(
		runMemoryEval(output, build, async () => {
			throw new Error("Must not answer without ready memory");
		}),
		/questions failed/,
	);
	assert.equal(await readFile(join(output, "answers-memory.jsonl"), "utf8"), "");
	assert.match(await readFile(join(output, "failures-memory.jsonl"), "utf8"), /q1/);
});

it("uses the same build project as the no-memory Pi cwd without opening its cached database", async () => {
	await writeFile(input, JSON.stringify([source, { ...source, question_id: "q2" }]));
	const build = await prepareRun([], 2);
	const projects = new Set<string>();
	await runMemoryEval(
		output,
		build,
		async ({ project, runtimeDirectory }) => {
			projects.add(project);
			assert.ok(runtimeDirectory.startsWith(output));
			return { text: "unknown", usage: [], elapsedMs: 1 };
		},
		"no-memory",
	);
	assert.equal(projects.size, 2);
	assert.ok([...projects].every((path) => path.includes(`${join("samples", "").slice(0, -1)}`)));
});

it("rebuilds an interrupted sample from a fresh database and skips completed samples", async () => {
	const build = await prepareRun();
	const prepared = await loadPreparedSample(build.directory, build.manifest.sampleDirectories[0]);
	const serializedConfig = JSON.stringify(config);
	await buildMemory(prepared, async () => "old summary");
	const dbPath = join(prepared.project, ".pi", "docs-memory", "index.db");
	await writeFile(`${dbPath}-wal`, "interrupted");
	await writeFile(`${dbPath}-shm`, "interrupted");
	assert.equal(await prepareMemoryBuild(prepared, serializedConfig), true);
	for (const suffix of ["", "-wal", "-shm"]) await assert.rejects(readFile(`${dbPath}${suffix}`), /ENOENT/);
	let calls = 0;
	await buildMemory(prepared, async () => {
		calls++;
		return "new summary";
	});
	assert.equal(calls, 1);
	await writeFile(join(prepared.directory, "memory-ready.json"), serializedConfig);
	const before = await readFile(dbPath);
	assert.equal(await prepareMemoryBuild(prepared, serializedConfig), false);
	assert.deepEqual(await readFile(dbPath), before);
	await assert.rejects(prepareMemoryBuild(prepared, "changed"), /configuration changed/);
	await assert.rejects(
		prepareMemoryBuild({ ...prepared, project: root }, serializedConfig),
		/refusing database deletion/,
	);
});
