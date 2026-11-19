import type { EvaluationSessionStorage, QuestionResult, TraceEvent } from "./types.ts";
/**
 * 在单个测试数据文件夹中创建Pi Agent，以实现Pi在不同会话测试集中的隔离效果
 *
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EmbeddingProvider } from "../../src/embedding/provider.ts";
import registerBatMem from "../../src/index.ts";
import type { RerankingProvider } from "../../src/reranking/provider.ts";
import { BM25_RECALL } from "../../src/search/strategies.ts";
import type { RetrievalOptions } from "../../src/search/types.ts";

/** Observe evidence and the actual Pi system prompt without replacing either. No provider headers are logged. */
export function createTraceExtension(trace: TraceEvent[]): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("tool_call", (event) => {
			console.info(`[answer] 调用工具：${event.toolName}`);
			trace.push({ type: "tool_call", data: structuredClone(event) });
		});
		pi.on("tool_result", (event) => {
			console.info(`[answer] 工具 ${event.toolName}：${event.isError ? "失败" : "完成"}`);
			trace.push({ type: "tool_result", data: structuredClone(event) });
		});
		pi.on("context", (event) => {
			trace.push({
				type: "memory_context",
				data: structuredClone(
					event.messages.filter(
						(message) =>
							message.role === "user" &&
							typeof message.content === "string" &&
							message.content.startsWith("Retrieved session evidence"),
					),
				),
			});
		});
		pi.on("context_with_system", (event) => {
			trace.push({
				type: "system_prompt",
				data: structuredClone(event.messages.filter((message) => message.role === "system")),
			});
		});
	};
}

/**
 * Create a fresh Pi Agent with its default system prompt and only BatMem's memory tools.
 * Model credentials come from the supplied runtime. All discovered resources/settings are isolated;
 * historical sessions and references are never restored into the answering Agent's conversation.
 * Retrieval selects the BatMem default for both automatic summary recall and memory_search.
 */
export async function createEvaluationSession(
	cwd: string,
	runtime: ModelRuntime,
	model: Model<Api>,
	trace: TraceEvent[],
	useMemory = true,
	storage?: EvaluationSessionStorage,
	retrieval: RetrievalOptions = BM25_RECALL,
	embedding?: EmbeddingProvider | null,
	reranking?: RerankingProvider | null,
): Promise<AgentSession> {
	const agentDir = storage?.agentDirectory ?? join(cwd, ".agent-config");
	const sessionDirectory = storage?.sessionDirectory ?? join(cwd, "sessions");
	await mkdir(agentDir, { recursive: true });
	await mkdir(sessionDirectory, { recursive: true });
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off",
		compaction: { enabled: false },
		retry: { enabled: false, provider: { maxRetries: 0 } },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			...(useMemory
				? [
					(pi: ExtensionAPI) =>
						registerBatMem(pi, {
							retrieval: { defaultStrategy: retrieval.id, strategies: { [retrieval.id]: retrieval } },
							evalMode: true,
							embedding,
							reranking,
						}),
				]
				: []),
			createTraceExtension(trace),
		],
	});
	await loader.reload();
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, sessionDirectory),
		tools: useMemory ? ["memory_search", "memory_read"] : [],
	});
	try {
		if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
		await session.bindExtensions({
			onError: (error) => {
				trace.push({ type: "extension_error", data: error });
			},
		});
		return session;
	} catch (error) {
		await closeEvaluationSession(session);
		throw error;
	}
}

/** Execute one fresh-session question, await settlement and keep only the final successful text response. */
export async function runQuestion(
	session: AgentSession,
	question: string,
	questionDate: string,
	timeoutMs = 120000,
): Promise<QuestionResult> {
	const start = Date.now();
	const offset = session.messages.length;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void session.abort();
	}, timeoutMs);
	try {
		await session.prompt(`Current Date: ${questionDate}\nQuestion: ${question}`, { expandPromptTemplates: false });
		if (timedOut) throw new Error("Question timed out.");
		const answers = session.messages
			.slice(offset)
			.filter((message): message is AssistantMessage => message.role === "assistant");
		const last = answers.at(-1);
		if (!last || last.stopReason !== "stop")
			throw new Error(last?.errorMessage ?? `No complete final response (${last?.stopReason}).`);
		const text = last.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
		if (!text) throw new Error("Empty final answer.");
		return { text, usage: answers.map((message) => message.usage), elapsedMs: Date.now() - start };
	} finally {
		clearTimeout(timer);
	}
}

/** Drain the extension before invalidating its captured context and database connection. */
export async function closeEvaluationSession(session: AgentSession): Promise<void> {
	try {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}
