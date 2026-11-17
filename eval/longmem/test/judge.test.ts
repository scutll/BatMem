import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createJudgePrompt, judgeAnswers, loadJudgePrompts, parseJudgeResponse, summarizeJudgments } from "../judge.ts";
import type { MemorySample } from "../dataset.ts";
import { createEvaluationRun, prepareBuild } from "../runner.ts";

const sample: MemorySample = {
	id: "q1",
	question: "Question with {answer}",
	date: "2023/05/30 (Tue) 23:40",
	type: "single-session-user",
	abstention: false,
	histories: [{ id: "s", date: "2023/05/20 (Sat) 02:21", messages: [{ role: "user", content: "history" }] }],
	reference: { answer: "cat", sessionIds: ["s"] },
};

it("uses official category prompts and rejects ambiguous verdicts", async () => {
	const prompts = await loadJudgePrompts();
	assert.equal(prompts.commit.length, 40);
	const prompt = createJudgePrompt(sample, "cat", prompts);
	assert.match(prompt, /Question with \{answer\}/);
	assert.match(createJudgePrompt({ ...sample, type: "temporal-reasoning" }, "cat", prompts), /off-by-one/);
	assert.match(createJudgePrompt({ ...sample, abstention: true }, "unknown", prompts), /unanswerable/);
	assert.equal(parseJudgeResponse(" Yes.\n"), true);
	assert.equal(parseJudgeResponse("no"), false);
	assert.throws(() => parseJudgeResponse("not yes"), /Invalid/);
});

it("validates answer completeness before any Judge call and aggregates judgments", async () => {
	const root = await mkdtemp(join(tmpdir(), "batmem-judge-"));
	try {
		const source = join(root, "source.json");
		await writeFile(source, "fixture");
		const run = join(root, "run");
		const build = await prepareBuild(
			{
				sourcePath: source,
				async *readSamples() {
					yield sample;
				},
			},
			join(root, "builds"),
			{ limit: 1, types: [] },
			{ model: "mock/summary", summaryPromptSha256: "prompt-hash", syncMode: "session-final" },
		);
		await createEvaluationRun(run, build);
		await writeFile(join(run, "answers-memory.jsonl"), "");
		let calls = 0;
		const generate = async () => {
			calls++;
			return { text: "yes", model: "mock-deepseek", usage: {} };
		};
		await assert.rejects(judgeAnswers(run, generate), /match all/);
		assert.equal(calls, 0);
		await writeFile(
			join(run, "answers-memory.jsonl"),
			`${JSON.stringify({ question_id: sample.id, hypothesis: "cat" })}\n`,
		);
		await judgeAnswers(run, generate);
		assert.equal(calls, 1);
		const metrics = JSON.parse(await readFile(join(run, "metrics-memory.json"), "utf8"));
		assert.equal(metrics.overall_accuracy, 1);
		assert.equal(metrics.retrieval, "search");
		assert.deepEqual(metrics.judge_models, ["mock-deepseek"]);
		const base = { question_id: "q", response: { text: "yes", model: "mock", usage: {} } };
		const grouped = summarizeJudgments([
			{ ...base, question_type: "multi-session", abstention: false, label: true },
			{ ...base, question_type: "multi-session", abstention: false, label: false },
			{ ...base, question_type: "knowledge-update", abstention: true, label: true },
		]);
		assert.equal(grouped.overall_accuracy, 2 / 3);
		assert.equal(grouped.task_averaged_accuracy, 0.75);
		assert.equal(grouped.abstention_accuracy, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
