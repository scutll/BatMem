import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openDatabase } from "../../../src/storage/db.ts";
import type { TraceEvent } from "../pi.ts";
import { closeEvaluationSession, createEvaluationSession, runQuestion } from "../pi.ts";

it("runs the real Pi SDK with a faux provider, default system prompt and only memory tools", async () => {
	const root = await mkdtemp(join(tmpdir(), "batmem-sdk-"));
	try {
		const buildProject = join(root, "build-project");
		const dbPath = join(buildProject, ".pi", "docs-memory", "index.db");
		const index = openDatabase(dbPath);
		index.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("history", "history.jsonl", buildProject);
		index.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?)").run("history", "entry", "pet is a cat", "2023-05-20");
		index.close();
		const before = await readFile(dbPath);
		const indexFiles = await readdir(join(buildProject, ".pi", "docs-memory"));
		const runtimeProject = join(root, "run-project");
		const runtimeDbPath = join(runtimeProject, ".pi", "docs-memory", "index.db");
		await mkdir(join(runtimeProject, ".pi", "docs-memory"), { recursive: true });
		await copyFile(dbPath, runtimeDbPath);
		const runtime = await ModelRuntime.create({
			refreshOnCreate: false,
			modelsPath: null,
			credentials: new InMemoryCredentialStore(),
		});
		const faux = createFauxCore({ provider: "batmem-test" });
		const base = faux.models[0];
		runtime.registerProvider("batmem-test", {
			api: faux.api,
			apiKey: "offline-faux-key",
			baseUrl: base.baseUrl,
			streamSimple: faux.streamSimple,
			models: [{ ...base, name: "Offline test", input: ["text"] }],
		});
		const model = runtime.getModel("batmem-test", base.id);
		assert.ok(model);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("memory_search", { query: "pet", topK: 1, mode: "vsearch" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("cat"),
		]);
		const trace: TraceEvent[] = [];
		const session = await createEvaluationSession(runtimeProject, runtime, model, trace, true, {
			agentDirectory: join(root, "agent"),
			sessionDirectory: join(root, "sessions"),
		});
		try {
			assert.deepEqual(session.getActiveToolNames().sort(), ["memory_read", "memory_search"]);
			const result = await runQuestion(session, "What is my pet?", "2023/05/30 (Tue) 23:40");
			assert.equal(result.text, "cat");
			assert.ok(
				trace.some((event) => event.type === "system_prompt" && JSON.stringify(event.data).includes("assistant")),
			);
			assert.equal(result.usage.length, 2);
			assert.ok(trace.some((event) => event.type === "tool_result" && JSON.stringify(event.data).includes("history")));
		} finally {
			await closeEvaluationSession(session);
		}
		const checked = openDatabase(runtimeDbPath);
		try {
			assert.deepEqual(checked.prepare("SELECT id FROM sessions").all().map((row) => row.id), ["history"]);
			assert.deepEqual(checked.prepare("SELECT session_id FROM summaries").all().map((row) => row.session_id), ["history"]);
		} finally {
			checked.close();
		}
		assert.equal((await readdir(join(root, "sessions"))).length, 1);
		assert.deepEqual(await readFile(dbPath), before);
		assert.deepEqual(await readdir(join(buildProject, ".pi", "docs-memory")), indexFiles);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
