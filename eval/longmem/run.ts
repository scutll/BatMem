import { createHash } from "node:crypto";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEmbeddingProvider, createRerankingProvider } from "../../src/models/create-providers.ts";
import type { JinaEmbeddingProvider } from "../../src/models/embedding/jina.ts";
import { generateSessionSummary, SUMMARY_SYSTEM_PROMPT } from "../../src/memory/summary.ts";
import type { JinaRerankingProvider } from "../../src/models/reranking/jina.ts";
import { isSearchMode, selectRetrievalOptions } from "../../src/retrieval/strategies/registry.ts";
import type { RetrievalOptions } from "../../src/retrieval/core/types.ts";
import { judgeAnswers } from "./scoring/judge.ts";
import { LONG_MEM_EVAL_QUESTION_TYPES, LongMemEvalDataset } from "./datasets/longmemeval.ts";
import { closeEvaluationSession, createEvaluationSession, runQuestion } from "./runtime/pi.ts";
import {
	buildMemory,
	buildMemoryVectors,
	createEvaluationRun,
	loadBuildManifest,
	loadEvaluationRun,
	loadPreparedSample,
	prepareBuild,
	prepareMemoryBuild,
	reconcileMemoryBuild,
	runMemoryEval,
} from "./workflow/runner.ts";
import type { MemoryBuildConfig, PreparedBuild } from "./workflow/types.ts";

/** CLI wiring only: build owns reusable data; each run directory owns answers and Judge results. */
const { values } = parseArgs({
	options: {
		stage: { type: "string", default: "prepare" },
		dataset: { type: "string" },
		builds: { type: "string" },
		output: { type: "string" },
		limit: { type: "string", default: "5" },
		types: { type: "string" },
		provider: { type: "string" },
		model: { type: "string" },
		"judge-provider": { type: "string" },
		"judge-model": { type: "string" },
		mode: { type: "string", default: "memory" },
		retrieval: { type: "string" },
		"timeout-ms": { type: "string", default: "120000" },
	},
});
const stage = values.stage;
if (!values.output || !["prepare", "build", "answer", "judge", "all"].includes(stage))
	throw new Error("Require --output and --stage prepare|build|answer|judge|all.");
if (values.mode !== "memory" && values.mode !== "no-memory") throw new Error("mode must be memory or no-memory.");
const requestedRetrieval = values.retrieval ?? "search";
if (!isSearchMode(requestedRetrieval)) throw new Error("retrieval must be search, vsearch or query.");
const mode = values.mode;
const output = resolve(values.output);
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid timeout-ms.");
const started = Date.now();
console.info(`[eval] 阶段：${stage}；模式：${mode}；输出：${output}`);

let build: PreparedBuild;
let retrieval: RetrievalOptions;
let embedding: JinaEmbeddingProvider | undefined;
let reranking: JinaRerankingProvider | undefined;
try {
	if (stage === "prepare" || stage === "all") {
		retrieval = selectRetrievalOptions(requestedRetrieval);
		if (retrieval.requiresEmbedding && mode === "no-memory") throw new Error(`${retrieval.id} requires memory mode.`);
		embedding = retrieval.requiresEmbedding ? createEmbeddingProvider() : undefined;
		if (retrieval.requiresEmbedding && !embedding)
			throw new Error(`${retrieval.id} requires JINA_API_KEY in BatMem/.env.`);
		if (!values.dataset || !values.provider || !values.model)
			throw new Error("Preparation requires --dataset, --provider and --model.");
		const limit = Number(values.limit);
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid limit.");
		const buildConfig: MemoryBuildConfig = {
			model: `${values.provider}/${values.model}`,
			summaryPromptSha256: createHash("sha256").update(SUMMARY_SYSTEM_PROMPT).digest("hex"),
			syncMode: "session-final",
		};
		const dataset = resolve(values.dataset);
		const buildsDirectory = resolve(values.builds ?? join(dirname(dataset), "builds"));
		const types =
			values.types
				?.split(",")
				.map((type) => type.trim())
				.filter(Boolean) ?? [];
		for (const type of types) {
			if (!LONG_MEM_EVAL_QUESTION_TYPES.has(type)) throw new Error(`Unknown LongMemEval question type: ${type}`);
		}
		build = await prepareBuild(new LongMemEvalDataset(dataset), buildsDirectory, { limit, types }, buildConfig);
		await createEvaluationRun(output, build, retrieval, embedding);
		console.info(`[prepare] run 已准备，引用 build：${build.manifest.fingerprint}`);
	} else {
		const run = await loadEvaluationRun(output);
		retrieval = selectRetrievalOptions(run.retrieval ?? "search");
		if (values.retrieval && values.retrieval !== retrieval.id)
			throw new Error("Retrieval mode differs from the run manifest.");
		if (retrieval.requiresEmbedding && stage !== "judge") {
			if (mode === "memory") {
				embedding = createEmbeddingProvider();
				if (!embedding) throw new Error(`${retrieval.id} requires JINA_API_KEY in BatMem/.env.`);
				if (embedding.identity !== run.embedding?.identity || embedding.dimensions !== run.embedding.dimensions)
					throw new Error("Embedding configuration differs from the prepared run.");
			}
		}
		const manifest = await loadBuildManifest(run.buildDirectory);
		if (run.buildFingerprint !== manifest.fingerprint) throw new Error("Run references a different build fingerprint.");
		if (!run.sampleDirectories.every((directory, index) => manifest.sampleDirectories[index] === directory))
			throw new Error("Run samples are not a prefix of the referenced build.");
		build = { directory: run.buildDirectory, manifest, sampleDirectories: run.sampleDirectories };
	}
	console.info(`[eval] 检索：${retrieval.id}；build：${build.directory}`);

	if (stage !== "prepare") {
		if (!values.provider || !values.model)
			throw new Error("Model calls require --provider and --model from your Pi configuration.");
		const runtime = await ModelRuntime.create();
		const registry = new ModelRegistry(runtime);
		const model = runtime.getModel(values.provider, values.model);
		if (!model) throw new Error(`Unknown configured model: ${values.provider}/${values.model}`);
		const selection = `${model.provider}/${model.id}`;
		console.info(`[eval] 模型：${selection}`);
		if ((stage === "build" || stage === "all") && mode === "memory" && selection !== build.manifest.buildConfig.model)
			throw new Error(`Build requires ${build.manifest.buildConfig.model}; create a new build for ${selection}.`);
		if ((stage === "build" || stage === "all") && mode === "memory") {
			const config = JSON.stringify(build.manifest.buildConfig);
			console.info(`[build] 开始为 ${build.sampleDirectories.length} 道题建立记忆`);
			for (const [index, relativeDirectory] of build.sampleDirectories.entries()) {
				const prepared = await loadPreparedSample(build.directory, relativeDirectory);
				if (!(await prepareMemoryBuild(prepared, config))) {
					reconcileMemoryBuild(prepared, true);
					console.info(`[build ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id} 已完成，跳过`);
				} else {
					console.info(
						`[build ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id}：${prepared.sessions.length} 个历史 Session`,
					);
					await buildMemory(prepared, (input) =>
						generateSessionSummary(
							{
								model,
								modelRegistry: {
									complete: async (requestModel, context, options) => {
										const response = await registry.complete(requestModel, context, options);
										await appendFile(
											join(prepared.directory, "summary-usage.jsonl"),
											`${JSON.stringify({ model: selection, usage: response.usage, stopReason: response.stopReason })}\n`,
										);
										return response;
									},
								},
							},
							input,
						),
					);
					await writeFile(join(prepared.directory, "memory-ready.json.tmp"), config);
					await rename(
						join(prepared.directory, "memory-ready.json.tmp"),
						join(prepared.directory, "memory-ready.json"),
					);
					console.info(
						`[build ${index + 1}/${build.sampleDirectories.length}] ${prepared.sample.id} 建库完成，已保存 memory-ready.json`,
					);
				}
				if (retrieval.requiresEmbedding && embedding) await buildMemoryVectors(prepared, embedding);
			}
		}
		if (stage === "answer" || stage === "all") {
			reranking = mode === "memory" ? createRerankingProvider() : undefined;
			await writeFile(
				join(output, `answer-config-${mode}.json`),
				JSON.stringify(
					{
						model: selection,
						timeoutMs,
						systemPrompt: "Pi SDK default; actual prompt recorded in traces",
						mode,
						retrieval: retrieval.id,
						embedding: embedding ? { identity: embedding.identity, dimensions: embedding.dimensions } : undefined,
					},
					null,
					2,
				),
				{ flag: "wx" },
			);
			await runMemoryEval(
				output,
				build,
				async ({ project, runtimeDirectory, question, date, trace }) => {
					const session = await createEvaluationSession(
						project,
						runtime,
						model,
						trace,
						mode === "memory",
						{
							agentDirectory: join(runtimeDirectory, "agent"),
							sessionDirectory: join(runtimeDirectory, "sessions"),
						},
						retrieval,
						embedding ?? null,
						reranking ?? null,
					);
					try {
						return await runQuestion(session, question, date, timeoutMs);
					} finally {
						console.info("[answer] 关闭 Pi 会话");
						await closeEvaluationSession(session);
					}
				},
				mode,
				retrieval,
				embedding,
			);
		}
		if (stage === "judge" || stage === "all") {
			const judgeModel = runtime.getModel(
				values["judge-provider"] ?? model.provider,
				values["judge-model"] ?? model.id,
			);
			if (!judgeModel) throw new Error("Unknown Judge model.");
			console.info(`[judge] 模型：${judgeModel.provider}/${judgeModel.id}`);
			await judgeAnswers(
				output,
				async (prompt) => {
					const response = await runtime.completeSimple(
						judgeModel,
						{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
						{ temperature: 0, timeoutMs, maxRetries: 0 },
					);
					if (response.stopReason !== "stop")
						throw new Error(response.errorMessage ?? `Judge ended with ${response.stopReason}`);
					return {
						text: response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
						model: `${judgeModel.provider}/${judgeModel.id}`,
						usage: response.usage,
					};
				},
				mode,
			);
		}
	}
	console.info(`[eval] ${stage} 完成，总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
	await embedding?.close();
	await reranking?.close();
}
