import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { clearLine, cursorTo } from "node:readline";
import type { EmbeddingProvider } from "../../src/embedding/provider.ts";
import { VectorIndex } from "../../src/embedding/vector-index.ts";
import { MemoryService } from "../../src/memory/service.ts";
import type { SummaryGenerator } from "../../src/memory/types.ts";
import { BM25_RECALL } from "../../src/search/strategies.ts";
import type { RetrievalOptions } from "../../src/search/types.ts";
import { openDatabase } from "../../src/storage/db.ts";
import type { MemoryDatasetLoader, MemorySample } from "./dataset.ts";
import { loadSessionSnapshot, parseHistoryDate, writeHistorySessions } from "./sessions.ts";
import type {
	AnswerQuestion,
	AnswerRequest,
	BuildSelection,
	EvaluationRunManifest,
	MemoryBuildConfig,
	MemoryBuildManifest,
	PreparedBuild,
	PreparedSample,
	TraceEvent,
} from "./types.ts";

/** Bump only when persisted Session/SQLite/summary-input formats become incompatible with existing builds. */
const BUILD_FORMAT = 1;

/** Store the question and reference outside the Pi cwd; only imported history is indexed. */
export async function prepareSample(sample: MemorySample, directory: string): Promise<PreparedSample> {
	parseHistoryDate(sample.date);
	const project = join(directory, "project");
	await mkdir(project, { recursive: true });
	const sessions = await writeHistorySessions(sample.histories, join(directory, "history"), project);
	const prepared = { sample, directory, project, sessions };
	await writeFile(join(directory, "sample.json"), JSON.stringify(prepared, null, 2), { flag: "wx" });
	return prepared;
}

async function sha256File(path: string | URL): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function collectCodeHashes(): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const name of [
		"./dataset.ts",
		"./types.ts",
		"./longmemeval.ts",
		"./sessions.ts",
		"../../src/storage/db.ts",
		"../../src/memory/service.ts",
		"../../src/memory/types.ts",
		"../../src/memory/summary.ts",
		"../../src/embedding/provider.ts",
		"../../src/embedding/types.ts",
		"../../src/embedding/jina.ts",
		"../../src/embedding/vector-index.ts",
		"../../src/search/types.ts",
		"../../src/search/bm25.ts",
		"../../src/search/vector.ts",
		"../../src/search/service.ts",
		"../../src/search/create-service.ts",
		"../../src/search/strategies.ts",
		"../../src/search/parallel-recall.ts",
		"../../src/search/passthrough-processor.ts",
		"../../src/reranking/provider.ts",
		"../../src/reranking/jina.ts",
		"../../src/reranking/types.ts",
		"../../src/search/recall.ts",
		"../../src/search/processor.ts",
		"../../src/search/bm25-embedding-recall.ts",
		"../../src/search/embedding-query-processor.ts",
		"../../src/search/modes.ts",
		"../../src/index.ts",
		"../../src/types.ts",
		"./pi.ts",
		"./run.ts",
		"../../src/search/rows.ts",
	])
		hashes[name] = await sha256File(new URL(name, import.meta.url));
	return hashes;
}

/** Compare only persisted-data inputs; code hashes are audit metadata, not cache identity. */
function hasCompatibleBuildIdentity(
	manifest: MemoryBuildManifest,
	sourceSha256: string,
	selection: { types: string[] },
	buildConfig: MemoryBuildConfig,
): boolean {
	return (
		(manifest.buildFormat === undefined || manifest.buildFormat === BUILD_FORMAT) &&
		manifest.sourceSha256 === sourceSha256 &&
		JSON.stringify(manifest.selection.types) === JSON.stringify(selection.types) &&
		JSON.stringify(manifest.buildConfig) === JSON.stringify(buildConfig)
	);
}

/** Locate compatible caches made before a non-semantic runner or source-code change. */
async function findCompatibleBuild(
	buildsDirectory: string,
	sourceSha256: string,
	selection: { types: string[] },
	buildConfig: MemoryBuildConfig,
): Promise<PreparedBuild | undefined> {
	for (const entry of await readdir(buildsDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = join(buildsDirectory, entry.name);
		try {
			const manifest: MemoryBuildManifest = JSON.parse(await readFile(join(directory, "build-manifest.json"), "utf8"));
			if (hasCompatibleBuildIdentity(manifest, sourceSha256, selection, buildConfig))
				return { directory, manifest, sampleDirectories: manifest.sampleDirectories };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return undefined;
}

function normalizeSelection(selection: BuildSelection): BuildSelection {
	if (!Number.isSafeInteger(selection.limit) || selection.limit < 1)
		throw new Error("limit must be a positive integer.");
	return {
		limit: selection.limit,
		types: [...new Set(selection.types.map((type) => type.trim()).filter(Boolean))].sort(),
	};
}

/**
 * Prepare or extend a build cache. limit only selects a prefix for this run; increasing it appends
 * missing samples to the same cache, while decreasing it reuses the existing prefix unchanged.
 */
export async function prepareBuild(
	loader: MemoryDatasetLoader,
	buildsDirectory: string,
	selection: BuildSelection,
	buildConfig: MemoryBuildConfig,
): Promise<PreparedBuild> {
	const normalizedSelection = normalizeSelection(selection);
	const selected: MemorySample[] = [];
	const allowedTypes = new Set(normalizedSelection.types);
	for await (const sample of loader.readSamples()) {
		if (allowedTypes.size && !allowedTypes.has(sample.type)) continue;
		selected.push(sample);
		if (selected.length === normalizedSelection.limit) break;
	}
	if (!selected.length) throw new Error("No samples selected.");
	const sourceSha256 = await sha256File(loader.sourcePath);
	const codeSha256 = await collectCodeHashes();
	const cacheSelection = { types: normalizedSelection.types };
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				buildFormat: BUILD_FORMAT,
				sourceSha256,
				selection: cacheSelection,
				buildConfig,
			}),
		)
		.digest("hex");
	const root = resolve(buildsDirectory);
	let directory = join(root, fingerprint);
	let manifestPath = join(directory, "build-manifest.json");
	await mkdir(root, { recursive: true });
	let existing: MemoryBuildManifest | undefined;
	try {
		const manifest: MemoryBuildManifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (manifest.fingerprint !== fingerprint) throw new Error("Build manifest fingerprint mismatch.");
		existing = manifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!existing) {
		const compatible = await findCompatibleBuild(root, sourceSha256, cacheSelection, buildConfig);
		if (compatible) {
			directory = compatible.directory;
			manifestPath = join(directory, "build-manifest.json");
			existing = compatible.manifest;
			console.info(`[prepare] 兼容复用旧 build：${existing.fingerprint}`);
		}
	}
	if (existing) {
		if (existing.sampleDirectories.length > selected.length) {
			console.info(`[prepare] 复用已有 build 前 ${selected.length} 题：${fingerprint}`);
			return { directory, manifest: existing, sampleDirectories: existing.sampleDirectories.slice(0, selected.length) };
		}
		for (const [index, relativeDirectory] of existing.sampleDirectories.entries()) {
			const prepared = await loadPreparedSample(directory, relativeDirectory);
			if (prepared.sample.id !== selected[index]?.id)
				throw new Error("Cached build sample order does not match dataset.");
		}
		if (existing.sampleDirectories.length === selected.length) {
			console.info(`[prepare] 复用已有 build：${fingerprint}`);
			return { directory, manifest: existing, sampleDirectories: existing.sampleDirectories };
		}
		console.info(
			`[prepare] 扩展已有 build：${fingerprint}；新增 ${selected.length - existing.sampleDirectories.length} 题`,
		);
		const existingCount = existing.sampleDirectories.length;
		const sampleDirectories = [...existing.sampleDirectories];
		for (const [index, sample] of selected.slice(existingCount).entries()) {
			const position = existingCount + index + 1;
			const relativeDirectory = join("samples", String(position).padStart(4, "0"));
			try {
				const prepared = await loadPreparedSample(directory, relativeDirectory);
				if (prepared.sample.id !== sample.id)
					throw new Error("Unregistered cache sample does not match dataset order.");
				console.info(`[prepare ${position}/${selected.length}] ${sample.id}：恢复上次中断前已生成的样本`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				console.info(
					`[prepare ${position}/${selected.length}] ${sample.id}：生成 ${sample.histories.length} 个历史 Session`,
				);
				await prepareSample(sample, join(directory, relativeDirectory));
			}
			sampleDirectories.push(relativeDirectory);
		}
		const manifest = { ...existing, sampleDirectories };
		await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
		await rename(`${manifestPath}.tmp`, manifestPath);
		return { directory, manifest, sampleDirectories };
	}
	try {
		await mkdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`Incomplete build exists and cannot be reused: ${directory}`);
		throw error;
	}
	const sampleDirectories: string[] = [];
	console.info(`[prepare] 生成 ${selected.length} 道题的 build：${fingerprint}`);
	for (const [index, sample] of selected.entries()) {
		const relativeDirectory = join("samples", String(index + 1).padStart(4, "0"));
		console.info(
			`[prepare ${index + 1}/${selected.length}] ${sample.id}：生成 ${sample.histories.length} 个历史 Session`,
		);
		await prepareSample(sample, join(directory, relativeDirectory));
		sampleDirectories.push(relativeDirectory);
	}
	const manifest: MemoryBuildManifest = {
		status: "prepared",
		buildFormat: BUILD_FORMAT,
		fingerprint,
		source: loader.sourcePath,
		sourceSha256,
		selection: cacheSelection,
		buildConfig,
		sampleDirectories,
		timeConvention: "dataset wall time mapped to UTC; message order preserved without invented per-turn times",
		codeSha256,
	};
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
	console.info(`[prepare] build 已准备：${directory}`);
	return { directory, manifest, sampleDirectories };
}

/** Create a disposable evaluation run that references, but never owns, cached history or SQLite data. */
export async function createEvaluationRun(
	output: string,
	build: PreparedBuild,
	retrieval: RetrievalOptions = BM25_RECALL,
	embedding?: EmbeddingProvider,
): Promise<EvaluationRunManifest> {
	if (retrieval.requiresEmbedding && !embedding) throw new Error(`${retrieval.id} requires an embedding provider.`);
	const root = resolve(output);
	await mkdir(dirname(root), { recursive: true });
	await mkdir(root);
	const manifest: EvaluationRunManifest = {
		status: "prepared",
		buildDirectory: build.directory,
		buildFingerprint: build.manifest.fingerprint,
		sampleDirectories: build.sampleDirectories,
		retrieval: retrieval.id,
		queryPipeline: retrieval.metadata
			? { recallPaths: [...retrieval.metadata.recallPaths], processor: retrieval.metadata.processor }
			: undefined,
		codeSha256: await collectCodeHashes(),
		embedding: embedding ? { identity: embedding.identity, dimensions: embedding.dimensions } : undefined,
	};
	await writeFile(join(root, "run-manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
	return manifest;
}

export async function loadEvaluationRun(output: string): Promise<EvaluationRunManifest> {
	return JSON.parse(await readFile(join(resolve(output), "run-manifest.json"), "utf8"));
}

export async function loadBuildManifest(directory: string): Promise<MemoryBuildManifest> {
	return JSON.parse(await readFile(join(resolve(directory), "build-manifest.json"), "utf8"));
}

export async function loadPreparedSample(buildDirectory: string, relativeDirectory: string): Promise<PreparedSample> {
	const root = resolve(buildDirectory);
	const directory = resolve(root, relativeDirectory);
	if (relative(root, directory).startsWith("..")) throw new Error("Sample path escapes build directory.");
	return JSON.parse(await readFile(join(directory, "sample.json"), "utf8"));
}

/** Skip completed samples; discard only an incomplete sample's database before rebuilding all its history. */
export async function prepareMemoryBuild(prepared: PreparedSample, config: string): Promise<boolean> {
	const project = resolve(prepared.directory, "project");
	if (resolve(prepared.project) !== project) throw new Error("Unexpected project path; refusing database deletion.");
	const dbPath = join(project, ".pi", "docs-memory", "index.db");
	const readyPath = join(prepared.directory, "memory-ready.json");
	try {
		const ready = await readFile(readyPath, "utf8");
		if (ready !== config) throw new Error("Completed sample build configuration changed.");
		if ((await stat(dbPath)).isFile()) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	console.info(`[build ${prepared.sample.id}] 未完成建库，清理 DB/WAL/SHM 后重新构建`);
	await rm(readyPath, { force: true });
	for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
	return true;
}

/** Remove answer sessions left by older evaluations while preserving imported history and its vectors. */
export function reconcileMemoryBuild(prepared: PreparedSample, repair: boolean): number {
	const db = openDatabase(join(prepared.project, ".pi", "docs-memory", "index.db"));
	try {
		const expected = new Set(prepared.sessions.map((session) => session.sessionId));
		const actual = new Set(
			db
				.prepare("SELECT id FROM sessions")
				.all()
				.map((row) => String(row.id)),
		);
		const missing = [...expected].filter((id) => !actual.has(id));
		if (missing.length)
			throw new Error(`Memory build is missing ${missing.length} imported sessions: ${prepared.sample.id}`);
		const summarized = new Set(
			db
				.prepare("SELECT session_id FROM summaries")
				.all()
				.map((row) => String(row.session_id)),
		);
		const unsummarized = [...expected].filter((id) => !summarized.has(id));
		if (unsummarized.length)
			throw new Error(`Memory build is missing ${unsummarized.length} historical summaries: ${prepared.sample.id}`);
		const extra = [...actual].filter((id) => !expected.has(id));
		if (!extra.length) return 0;
		if (!repair) throw new Error(`Memory build contains ${extra.length} non-history sessions: ${prepared.sample.id}`);
		db.exec("BEGIN IMMEDIATE");
		try {
			const remove = db.prepare("DELETE FROM sessions WHERE id = ?");
			for (const id of extra) remove.run(id);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		console.info(`[build ${prepared.sample.id}] 清理 ${extra.length} 个旧评测问答 Session`);
		return extra.length;
	} finally {
		db.close();
	}
}

/** Index each imported session once. Generation failures prevent publication of the ready marker. */
export async function buildMemory(prepared: PreparedSample, generateSummary: SummaryGenerator): Promise<void> {
	const db = openDatabase(join(prepared.project, ".pi", "docs-memory", "index.db"));
	const start = Date.now();
	try {
		const service = new MemoryService(db);
		for (const [index, imported] of prepared.sessions.entries()) {
			if (process.stdout.isTTY) {
				cursorTo(process.stdout, 0);
				clearLine(process.stdout, 0);
				const progress = `[build ${prepared.sample.id}] Session ${index + 1}/${prepared.sessions.length} | ${imported.messageCount} msgs | syncing`;
				process.stdout.write(progress.slice(0, Math.max(1, (process.stdout.columns ?? 80) - 1)));
			}
			const digest = createHash("sha256")
				.update(await readFile(imported.path))
				.digest("hex");
			if (digest !== imported.sha256) throw new Error("History file changed since preparation.");
			const snapshot = loadSessionSnapshot(imported.path);
			if (snapshot.entries.length !== imported.messageCount) throw new Error("History changed since preparation.");
			await service.syncSession(snapshot, generateSummary);
		}
		const count = db.prepare("SELECT COUNT(*) AS n FROM summaries").get()?.n;
		if (count !== prepared.sessions.length) throw new Error("Incomplete memory index.");
	} catch (error) {
		if (process.stdout.isTTY) process.stdout.write("\n");
		console.error(`[build ${prepared.sample.id}] 失败：${String(error)}`);
		throw error;
	} finally {
		if (process.stdout.isTTY) {
			cursorTo(process.stdout, 0);
			clearLine(process.stdout, 0);
		}
		db.close();
	}
	console.info(
		`[build ${prepared.sample.id}] ${prepared.sessions.length} 条摘要已就绪，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`,
	);
}

/** Complete missing vectors in a reusable summary database without rerunning the summary model. */
export async function buildMemoryVectors(prepared: PreparedSample, embedding: EmbeddingProvider): Promise<void> {
	const db = openDatabase(join(prepared.project, ".pi", "docs-memory", "index.db"));
	try {
		const index = new VectorIndex(db, embedding);
		index.initialize();
		const before = index.getStatus("memory");
		console.info(`[vector ${prepared.sample.id}] 已有 ${before.indexed}/${before.total}；待生成 ${before.pending}`);
		const memory = new MemoryService(db, { embedding });
		const started = Date.now();
		let lastLog = 0;
		const timer = setInterval(() => {
			const status = index.getStatus("memory");
			const line = `[vector ${prepared.sample.id}] ${status.indexed}/${status.total}；剩余 ${status.pending}；耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`;
			if (process.stdout.isTTY) {
				cursorTo(process.stdout, 0);
				clearLine(process.stdout, 0);
				process.stdout.write(line.slice(0, Math.max(1, (process.stdout.columns ?? 80) - 1)));
			} else if (Date.now() - lastLog >= 10_000) {
				console.info(line);
				lastLog = Date.now();
			}
		}, 1000);
		timer.unref();
		try {
			await memory.ready;
		} finally {
			clearInterval(timer);
			if (process.stdout.isTTY) {
				cursorTo(process.stdout, 0);
				clearLine(process.stdout, 0);
			}
		}
		index.assertReady("memory", embedding);
		const after = index.getStatus("memory");
		console.info(`[vector ${prepared.sample.id}] ${after.indexed}/${after.total} 条摘要向量已就绪`);
	} finally {
		db.close();
	}
}

/** Execute fresh Agent questions against a run-local copy, leaving the reusable build untouched. */
export async function runMemoryEval(
	runDirectory: string,
	build: PreparedBuild,
	answer: AnswerQuestion,
	mode: "memory" | "no-memory" = "memory",
	retrieval: RetrievalOptions = BM25_RECALL,
	embedding?: EmbeddingProvider,
): Promise<void> {
	if (mode === "memory" && retrieval.requiresEmbedding && !embedding)
		throw new Error(`${retrieval.id} requires an embedding provider.`);
	const root = resolve(runDirectory);
	const answersPath = join(root, `answers-${mode}.jsonl`);
	await writeFile(answersPath, "", { flag: "wx" });
	const failuresPath = join(root, `failures-${mode}.jsonl`);
	let failed = 0;
	console.info(`[answer] 开始 ${build.sampleDirectories.length} 道题，模式：${mode}`);
	for (const [index, relativeDirectory] of build.sampleDirectories.entries()) {
		const prepared = await loadPreparedSample(build.directory, relativeDirectory);
		const runtimeDirectory = join(root, relativeDirectory);
		await mkdir(runtimeDirectory, { recursive: true });
		const trace: TraceEvent[] = [];
		const start = Date.now();
		console.info(
			`[answer ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id}：创建 Pi 会话并等待回答`,
		);
		try {
			if (mode === "memory") await readFile(join(prepared.directory, "memory-ready.json"));
			const project = mode === "memory" ? join(runtimeDirectory, "project") : prepared.project;
			if (mode === "memory") {
				const source = join(prepared.project, ".pi", "docs-memory", "index.db");
				const targetDirectory = join(project, ".pi", "docs-memory");
				await mkdir(targetDirectory, { recursive: true });
				// SQLite may retain committed pages in WAL; keep the three files together in the run.
				for (const suffix of ["", "-wal", "-shm"]) {
					try {
						await copyFile(`${source}${suffix}`, join(targetDirectory, `index.db${suffix}`));
					} catch (error) {
						if (!suffix || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				reconcileMemoryBuild({ ...prepared, project }, false);
			}
			if (mode === "memory" && retrieval.requiresEmbedding && embedding) {
				const db = openDatabase(join(project, ".pi", "docs-memory", "index.db"));
				try {
					new VectorIndex(db, embedding).assertReady("memory", embedding);
				} finally {
					db.close();
				}
			}
			const request: AnswerRequest = {
				project,
				runtimeDirectory,
				question: prepared.sample.question,
				date: prepared.sample.date,
				trace,
			};
			const result = await answer(request);
			if (!result.text.trim()) throw new Error("Empty hypothesis.");
			await writeFile(join(runtimeDirectory, `answer-${mode}.json`), JSON.stringify(result, null, 2));
			await appendFile(
				answersPath,
				`${JSON.stringify({ question_id: prepared.sample.id, hypothesis: result.text })}\n`,
			);
			console.info(
				`[answer ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id} 已保存，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`,
			);
		} catch (error) {
			failed++;
			console.error(
				`[answer ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id} 失败：${String(error)}`,
			);
			await appendFile(failuresPath, `${JSON.stringify({ question_id: prepared.sample.id, error: String(error) })}\n`);
		} finally {
			await writeFile(
				join(runtimeDirectory, `trace-${mode}.jsonl`),
				trace.map((event) => JSON.stringify(event)).join("\n"),
			);
		}
	}
	console.info(`[answer] 完成：成功 ${build.sampleDirectories.length - failed}，失败 ${failed}；回答：${answersPath}`);
	if (failed) throw new Error(`${failed} questions failed; see ${failuresPath}. Incomplete answers cannot be judged.`);
}
