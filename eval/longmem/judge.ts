import { appendFile, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemorySample } from "./dataset.ts";
import { loadBuildManifest, loadEvaluationRun, loadPreparedSample } from "./runner.ts";

export interface JudgePrompts {
	repository: string;
	commit: string;
	source: string;
	sha256: string;
	templates: Record<string, string>;
}
export interface JudgeResponse {
	text: string;
	model: string;
	usage: unknown;
}
export interface Judgment {
	question_id: string;
	question_type: string;
	abstention: boolean;
	label: boolean;
	response: JudgeResponse;
}

/** Read vendored templates extracted from the official function at the recorded commit. No network fetch at runtime. */
export async function loadJudgePrompts(): Promise<JudgePrompts> {
	return JSON.parse(await readFile(new URL("./judge-prompts.json", import.meta.url), "utf8"));
}

/** Single-pass substitution prevents answer text containing placeholder-like strings from being reinterpreted. */
export function createJudgePrompt(sample: MemorySample, hypothesis: string, prompts: JudgePrompts): string {
	const template = prompts.templates[sample.abstention ? "abstention" : sample.type];
	if (!template) throw new Error(`No official Judge template for ${sample.type}`);
	const values: Record<string, string> = {
		question: sample.question,
		answer: sample.reference.answer,
		response: hypothesis,
	};
	return template.replace(/\{(question|answer|response)\}/g, (_match, key: string) => values[key]);
}

/** Reject ambiguous model output instead of letting a substring such as "not yes" silently pass. */
export function parseJudgeResponse(text: string): boolean {
	const verdict = text.trim().toLowerCase().replace(/[.!]$/, "");
	if (verdict !== "yes" && verdict !== "no") throw new Error(`Invalid Judge verdict: ${text}`);
	return verdict === "yes";
}

// 汇总评测结果
/** Aggregate official binary judgments. Report both question-weighted and task-weighted accuracy. */
export function summarizeJudgments(judgments: Judgment[]): {
	query_count: number;
	overall_accuracy: number;
	task_averaged_accuracy: number;
	abstention_accuracy: number | null;
	by_type: Record<string, { count: number; accuracy: number }>;
} {
	if (!judgments.length) throw new Error("No judgments.");
	const groups = new Map<string, boolean[]>();
	for (const row of judgments) groups.set(row.question_type, [...(groups.get(row.question_type) ?? []), row.label]);
	const by_type: Record<string, { count: number; accuracy: number }> = {};
	for (const [type, labels] of groups)
		by_type[type] = { count: labels.length, accuracy: labels.filter(Boolean).length / labels.length };
	const abstentions = judgments.filter((row) => row.abstention);
	return {
		query_count: judgments.length,
		overall_accuracy: judgments.filter((row) => row.label).length / judgments.length,
		task_averaged_accuracy: Object.values(by_type).reduce((sum, row) => sum + row.accuracy, 0) / groups.size,
		abstention_accuracy: abstentions.length ? abstentions.filter((row) => row.label).length / abstentions.length : null,
		by_type,
	};
}

/**
 * Validate answer completeness before making any Judge calls. Keep official prompts, but route through
 * an injected model adapter so DeepSeek and any configured Pi provider can be used without API-key duplication.
 * Ambiguous verdicts or provider errors stop scoring; no misleading partial metrics are written.
 */
export async function judgeAnswers(
	output: string,
	generate: (prompt: string) => Promise<JudgeResponse>,
	mode: "memory" | "no-memory" = "memory",
): Promise<void> {
	const root = resolve(output);
	const run = await loadEvaluationRun(root);
	const manifest = await loadBuildManifest(run.buildDirectory);
	if (run.buildFingerprint !== manifest.fingerprint) throw new Error("Run references a different build fingerprint.");
	const samples: MemorySample[] = [];
	for (const relative of run.sampleDirectories) {
		const prepared = await loadPreparedSample(run.buildDirectory, relative);
		samples.push(prepared.sample);
	}
	const answers = new Map<string, string>();
	for (const line of (await readFile(join(root, `answers-${mode}.jsonl`), "utf8")).split("\n").filter(Boolean)) {
		const row: { question_id: string; hypothesis: string } = JSON.parse(line);
		if (answers.has(row.question_id) || typeof row.hypothesis !== "string" || !row.hypothesis.trim())
			throw new Error("Duplicate or empty hypothesis.");
		answers.set(row.question_id, row.hypothesis);
	}
	if (answers.size !== samples.length || samples.some((sample) => !answers.has(sample.id)))
		throw new Error("Answers do not match all prepared questions.");
	const prompts = await loadJudgePrompts();
	const file = await open(join(root, `judge-results-${mode}.jsonl`), "wx");
	const judgments: Judgment[] = [];
	console.info(`[judge] 回答完整性校验通过，开始评分 ${samples.length} 道题`);
	try {
		for (const [index, sample] of samples.entries()) {
			let response: JudgeResponse | undefined;
			const start = Date.now();
			console.info(`[judge ${index + 1}/${samples.length}] ${sample.id} (${sample.type})：等待 Judge`);
			try {
				// 调用LLM对answer进行评审
				response = await generate(createJudgePrompt(sample, answers.get(sample.id) ?? "", prompts));
				const label = parseJudgeResponse(response.text);
				const row: Judgment = {
					question_id: sample.id,
					question_type: sample.type,
					abstention: sample.abstention,
					label,
					response,
				};
				judgments.push(row);
				await file.write(`${JSON.stringify(row)}\n`);
				console.info(
					`[judge ${index + 1}/${samples.length}] ${sample.id}：${label ? "正确" : "错误"}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`,
				);
			} catch (error) {
				console.error(`[judge ${index + 1}/${samples.length}] ${sample.id} 评分失败：${String(error)}`);
				await appendFile(
					join(root, `judge-failures-${mode}.jsonl`),
					`${JSON.stringify({ question_id: sample.id, response, error: String(error) })}\n`,
				);
				throw error;
			}
		}
	} finally {
		await file.close();
	}
	const metrics = {
		...summarizeJudgments(judgments),
		judge_models: [...new Set(judgments.map((row) => row.response.model))],
		official_prompt_commit: prompts.commit,
		verdict_policy: "strict yes/no; invalid responses fail the run",
		mode,
	};
	await writeFile(join(root, `metrics-${mode}.json`), JSON.stringify(metrics, null, 2));
	console.info(`\n[result] 模式：${mode}；评分模型：${metrics.judge_models.join(", ")}`);
	console.info(
		`query_count: ${metrics.query_count} - 已评分问题数，正确 ${judgments.filter((row) => row.label).length}，错误 ${judgments.filter((row) => !row.label).length}`,
	);
	console.log(`overall_accuracy: ${metrics.overall_accuracy.toFixed(4)} - 所有问题的回答正确率`);
	console.log(`task_averaged_accuracy: ${metrics.task_averaged_accuracy.toFixed(4)} - 各类问题正确率的等权平均`);
	for (const [type, row] of Object.entries(metrics.by_type))
		console.log(`${type}: ${row.accuracy.toFixed(4)} - 该类别 ${row.count} 道题的正确率`);
	if (metrics.abstention_accuracy !== null)
		console.log(`abstention_accuracy: ${metrics.abstention_accuracy.toFixed(4)} - 不可回答问题的正确拒答率`);
	console.info(`[result] 逐题判定：${join(root, `judge-results-${mode}.jsonl`)}`);
	console.info(`[result] 指标报告：${join(root, `metrics-${mode}.json`)}`);
}
