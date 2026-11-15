import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TraceEvent } from "../pi.ts";
import { closeEvaluationSession, createEvaluationSession, runQuestion } from "../pi.ts";

it("runs the real Pi SDK with a faux provider, default system prompt and only memory tools", async () => {
	const root = await mkdtemp(join(tmpdir(), "batmem-sdk-"));
	try {
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
		faux.setResponses([fauxAssistantMessage("cat"), fauxAssistantMessage("summary")]);
		const trace: TraceEvent[] = [];
		const session = await createEvaluationSession(root, runtime, model, trace);
		try {
			assert.deepEqual(session.getActiveToolNames().sort(), ["memory_read", "memory_search"]);
			const result = await runQuestion(session, "What is my pet?", "2023/05/30 (Tue) 23:40");
			assert.equal(result.text, "cat");
			assert.ok(
				trace.some((event) => event.type === "system_prompt" && JSON.stringify(event.data).includes("assistant")),
			);
			assert.equal(result.usage.length, 1);
		} finally {
			await closeEvaluationSession(session);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
