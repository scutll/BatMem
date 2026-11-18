import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { closeEvaluationSession } from "../eval/longmem/pi.ts";
import type { EmbeddingProvider } from "../src/embedding/provider.ts";
import registerBatMem from "../src/index.ts";
import { openDatabase } from "../src/storage/db.ts";
import { mockReranking } from "./helpers/reranking.ts";

for (const enabled of [true, false]) {
	it(`ordinary memory/document tools support query with embeddings ${enabled ? "enabled" : "disabled"}`, async (context) => {
		mockReranking(context.mock);
		const root = await mkdtemp(join(tmpdir(), "batmem-extension-"));
		let closed = 0;
		const queries: string[] = [];
		const embedding: EmbeddingProvider & { close(): Promise<void> } = {
			identity: "test/extension:v1",
			dimensions: 2,
			async embedDocuments(texts) {
				return texts.map(() => [1, 0]);
			},
			async embedQuery(query) {
				queries.push(query);
				return [1, 0];
			},
			async close() {
				closed++;
			},
		};
		try {
			const project = join(root, "project");
			const documents = join(project, ".pi", "docs-memory", "documents");
			await mkdir(documents, { recursive: true });
			await writeFile(join(documents, "guide.md"), "# Guide\nknown document evidence\n");
			const db = openDatabase(join(project, ".pi", "docs-memory", "index.db"));
			db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("history", "history.jsonl", project);
			db.prepare("INSERT INTO summaries VALUES (?, ?, ?, ?)").run(
				"history",
				"entry",
				"known summary evidence",
				"2026-01-01",
			);
			db.close();
			const runtime = await ModelRuntime.create({
				refreshOnCreate: false,
				modelsPath: null,
				credentials: new InMemoryCredentialStore(),
			});
			const faux = createFauxCore({ provider: "batmem-extension-test" });
			const model = faux.models[0];
			runtime.registerProvider(model.provider, {
				api: faux.api,
				apiKey: "offline",
				baseUrl: model.baseUrl,
				streamSimple: faux.streamSimple,
				models: [{ ...model, input: ["text"] }],
			});
			const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
			const loader = new DefaultResourceLoader({
				cwd: project,
				agentDir: join(root, "agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [(pi) => registerBatMem(pi, { embedding: enabled ? embedding : null })],
			});
			await loader.reload();
			const { session, extensionsResult } = await createAgentSession({
				cwd: project,
				agentDir: join(root, "agent"),
				modelRuntime: runtime,
				model,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.create(project, join(root, "sessions")),
				tools: ["memory_search", "rag_search"],
			});
			try {
				assert.deepEqual(extensionsResult.errors, []);
				const errors: unknown[] = [];
				await session.bindExtensions({
					onError: (error) => {
						errors.push(error);
					},
				});
				for (const name of ["memory_search", "rag_search"]) {
					const tool = session.extensionRunner.getToolDefinition(name);
					assert.ok(tool);
					const execute = () =>
						tool.execute(
							"offline-call",
							{ query: "unrelated", topK: 1, mode: "query" },
							undefined,
							undefined,
							session.extensionRunner.createToolContext("offline-call", undefined),
						);
					if (enabled) {
						const result = await execute();
						const content = result.content[0];
						assert.equal(content.type, "text");
						if (content.type !== "text") throw new Error("Expected text output");
						const hits = JSON.parse(content.text);
						assert.equal(hits.length, 1);
						assert.equal(hits[0].sourceType, name === "memory_search" ? "memory" : "document");
						if (name === "rag_search") {
							assert.equal(hits[0].location.sourcePath, join(documents, "guide.md"));
							assert.equal(hits[0].location.startLine, 1);
						} else assert.equal(hits[0].location.entryId, "entry");
					} else {
						await assert.rejects(execute(), /requires vector/);
						const result = await tool.execute(
							"lexical",
							{ query: "known", mode: "search" },
							undefined,
							undefined,
							session.extensionRunner.createToolContext("lexical", undefined),
						);
						assert.ok(JSON.stringify(result).includes("evidence"));
					}
				}
				assert.deepEqual(errors, []);
			} finally {
				await closeEvaluationSession(session);
			}
			assert.equal(closed, 0, "extension must not close a borrowed provider");
			assert.equal(queries.length, enabled ? 2 : 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
