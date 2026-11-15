import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { clearLine, cursorTo } from "node:readline";
import { openDatabase } from "../../src/db.ts";
import { MemoryService } from "../../src/memory.ts";
import type { SummaryGenerator } from "../../src/types.ts";
import type { MemoryDatasetLoader, MemorySample } from "./dataset.ts";
import type { QuestionResult, TraceEvent } from "./pi.ts";
import type { ImportedSession } from "./sessions.ts";
import { loadSessionSnapshot, parseHistoryDate, writeHistorySessions } from "./sessions.ts";

export interface PreparedSample {
	sample: MemorySample;
	directory: string;
	project: string;
	sessions: ImportedSession[];
}

/** Inputs that can change indexed summaries or their SQLite representation. */
export interface MemoryBuildConfig {
	model: string;
	summaryPromptSha256: string;
	syncMode: "session-final";
}

/** Limit is applied after optional type filtering and belongs to a run, not a cached build. */
export interface BuildSelection {
	limit: number;
	types: string[];
}

/** Append-only cache description. The fingerprint is independent of a run's limit and cache growth. */
export interface MemoryBuildManifest {
	status: "prepared";
	buildFormat: number;
	fingerprint: string;
	source: string;
	sourceSha256: string;
	selection: { types: string[] };
	buildConfig: MemoryBuildConfig;
	sampleDirectories: string[];
	timeConvention: string;
	codeSha256: Record<string, string>;
}

/** Bump only when persisted Session/SQLite/summary-input formats become incompatible with existing builds. */
const BUILD_FORMAT = 1;

/** A run points to a build cache and owns only its answer and Judge artifacts. */
export interface EvaluationRunManifest {
	status: "prepared";
	buildDirectory: string;
	buildFingerprint: string;
	sampleDirectories: string[];
}

export interface PreparedBuild {
	directory: string;
	manifest: MemoryBuildManifest;
	sampleDirectories: string[];
}

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
		"./longmemeval.ts",
		"./sessions.ts",
		"../../src/db.ts",
		"../../src/memory.ts",
		"../../src/summary.ts",
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
	if (!Number.isSafeInteger(selection.limit) || selection.limit < 1) throw new Error("limit must be a positive integer.");
	return { limit: selection.limit, types: [...new Set(selection.types.map((type) => type.trim()).filter(Boolean))].sort() };
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
			if (prepared.sample.id !== selected[index]?.id) throw new Error("Cached build sample order does not match dataset.");
		}
		if (existing.sampleDirectories.length === selected.length) {
			console.info(`[prepare] 复用已有 build：${fingerprint}`);
			return { directory, manifest: existing, sampleDirectories: existing.sampleDirectories };
		}
		console.info(`[prepare] 扩展已有 build：${fingerprint}；新增 ${selected.length - existing.sampleDirectories.length} 题`);
		const existingCount = existing.sampleDirectories.length;
		const sampleDirectories = [...existing.sampleDirectories];
		for (const [index, sample] of selected.slice(existingCount).entries()) {
			const position = existingCount + index + 1;
			const relativeDirectory = join("samples", String(position).padStart(4, "0"));
			try {
				const prepared = await loadPreparedSample(directory, relativeDirectory);
				if (prepared.sample.id !== sample.id) throw new Error("Unregistered cache sample does not match dataset order.");
				console.info(`[prepare ${position}/${selected.length}] ${sample.id}：恢复上次中断前已生成的样本`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				console.info(`[prepare ${position}/${selected.length}] ${sample.id}：生成 ${sample.histories.length} 个历史 Session`);
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
		console.info(`[prepare ${index + 1}/${selected.length}] ${sample.id}：生成 ${sample.histories.length} 个历史 Session`);
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
export async function createEvaluationRun(output: string, build: PreparedBuild): Promise<EvaluationRunManifest> {
	const root = resolve(output);
	await mkdir(dirname(root), { recursive: true });
	await mkdir(root);
	const manifest: EvaluationRunManifest = {
		status: "prepared",
		buildDirectory: build.directory,
		buildFingerprint: build.manifest.fingerprint,
		sampleDirectories: build.sampleDirectories,
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
			const digest = createHash("sha256").update(await readFile(imported.path)).digest("hex");
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
	console.info(`[build ${prepared.sample.id}] ${prepared.sessions.length} 条摘要已就绪，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

export interface AnswerRequest {
	project: string;
	runtimeDirectory: string;
	question: string;
	date: string;
	trace: TraceEvent[];
}

/** The run owns ephemeral Pi files; the build project stays the Extension cwd that locates memory. */
export type AnswerQuestion = (request: AnswerRequest) => Promise<QuestionResult>;

/**
 * Pi synchronizes the new question at agent_end, temporarily modifying the build database. Snapshot
 * and restore keeps that session out of the reusable cache. A lock prevents concurrent runs sharing it.
 */
async function answerWithRestoredBuildDatabase<T>(prepared: PreparedSample, runtimeDirectory: string, action: () => Promise<T>): Promise<T> {
	const dbPath = join(prepared.project, ".pi", "docs-memory", "index.db");
	const lockPath = join(prepared.directory, ".answer.lock");
	const backupDirectory = join(runtimeDirectory, ".memory-backup");
	try {
		await writeFile(lockPath, runtimeDirectory, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`Another answer process is using build sample ${prepared.sample.id}.`);
		throw error;
	}
	try {
		await mkdir(backupDirectory, { recursive: true });
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				await copyFile(`${dbPath}${suffix}`, join(backupDirectory, `index.db${suffix}`));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		try {
			return await action();
		} finally {
			for (const suffix of ["", "-wal", "-shm"]) await rm(`${dbPath}${suffix}`, { force: true });
			for (const suffix of ["", "-wal", "-shm"]) {
				const backupPath = join(backupDirectory, `index.db${suffix}`);
				try {
					await copyFile(backupPath, `${dbPath}${suffix}`);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		}
	} finally {
		await rm(backupDirectory, { recursive: true, force: true });
		await unlink(lockPath).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

/** Execute fresh Agent questions. Results live in run/, while the Pi cwd is the matching build project. */
export async function runMemoryEval(
	runDirectory: string,
	build: PreparedBuild,
	answer: AnswerQuestion,
	mode: "memory" | "no-memory" = "memory",
): Promise<void> {
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
		console.info(`[answer ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id}：创建 Pi 会话并等待回答`);
		try {
			if (mode === "memory") await readFile(join(prepared.directory, "memory-ready.json"));
			const request: AnswerRequest = {
				project: prepared.project,
				runtimeDirectory,
				question: prepared.sample.question,
				date: prepared.sample.date,
				trace,
			};
			const result = mode === "memory" ? await answerWithRestoredBuildDatabase(prepared, runtimeDirectory, () => answer(request)) : await answer(request);
			if (!result.text.trim()) throw new Error("Empty hypothesis.");
			await writeFile(join(runtimeDirectory, `answer-${mode}.json`), JSON.stringify(result, null, 2));
			await appendFile(answersPath, `${JSON.stringify({ question_id: prepared.sample.id, hypothesis: result.text })}\n`);
			console.info(`[answer ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id} 已保存，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
		} catch (error) {
			failed++;
			console.error(`[answer ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id} 失败：${String(error)}`);
			await appendFile(failuresPath, `${JSON.stringify({ question_id: prepared.sample.id, error: String(error) })}\n`);
		} finally {
			await writeFile(join(runtimeDirectory, `trace-${mode}.jsonl`), trace.map((event) => JSON.stringify(event)).join("\n"));
		}
	}
	console.info(`[answer] 完成：成功 ${build.sampleDirectories.length - failed}，失败 ${failed}；回答：${answersPath}`);
	if (failed) throw new Error(`${failed} questions failed; see ${failuresPath}. Incomplete answers cannot be judged.`);
}
