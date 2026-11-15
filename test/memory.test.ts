import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { openDatabase } from "../src/db.ts";
import { MemoryService } from "../src/memory.ts";

// Construct session-shaped inputs; no session files or real model requests are needed.
function createUserMessage(id: string, parentId: string | null, text: string, second = 0): SessionEntry {
	const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, second));
	return {
		type: "message",
		id,
		parentId,
		timestamp: timestamp.toISOString(),
		message: { role: "user", content: text, timestamp: timestamp.getTime() },
	};
}

function createConversation(): SessionEntry[] {
	const user = createUserMessage("u1", null, "USER_MARKER deployment", 1);
	const answer: SessionEntry = {
		type: "message",
		id: "answer",
		parentId: "u1",
		timestamp: "2026-01-01T00:00:04.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ASSISTANT_MARKER needle answer" }],
			api: "openai-responses",
			provider: "openai",
			model: "offline",
			stopReason: "stop",
			timestamp: Date.UTC(2026, 0, 1, 0, 0, 4),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
	const tool: SessionEntry = {
		type: "message",
		id: "tool",
		parentId: "answer",
		timestamp: "2026-01-01T00:00:05.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "TOOL_MARKER needle tool" }],
			isError: false,
			timestamp: Date.UTC(2026, 0, 1, 0, 0, 5),
		},
	};
	return [user, answer, tool];
}

describe("cross-session memory", () => {
	let directory: string;
	let db: DatabaseSync;
	let memory: MemoryService;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "batmem-memory-"));
		db = openDatabase(join(directory, "nested", "index.db"));
		memory = new MemoryService(db);
	});

	afterEach(async () => {
		db?.close();
		await rm(directory, { recursive: true, force: true });
	});

	function createSessionSnapshot(entries: SessionEntry[], sessionId = "session-a") {
		return { sessionId, sourcePath: join(directory, `${sessionId}.jsonl`), projectPath: directory, entries };
	}

	it("summarizes a new session and returns its source through full-text search", async () => {
		const summarize = mock.fn(async (_text: string) => "quasar deployment decision");
		const entries = createConversation();
		await memory.syncSession(createSessionSnapshot(entries), summarize);
		assert.equal(summarize.mock.callCount(), 1);
		const input = summarize.mock.calls[0].arguments[0];
		assert.match(input, /USER_MARKER/);
		assert.match(input, /ASSISTANT_MARKER/);
		assert.match(input, /TOOL_MARKER/);
		const hits = memory.searchSummaries({ query: "quasar", topK: 5 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].text, "quasar deployment decision");
		assert.equal(hits[0].sourceType, "memory");
		assert.equal(hits[0].sourceId, "session-a");
		assert.equal(hits[0].location.entryId, "tool");
		assert.equal(hits[0].location.sourcePath, join(directory, "session-a.jsonl"));
		assert.ok(Number.isFinite(hits[0].score));
	});

	it("updates using the previous summary and only messages after the saved entry", async () => {
		const first = createUserMessage("u1", null, "OLD_RAW_MARKER");
		await memory.syncSession(createSessionSnapshot([first]), async () => "PREVIOUS_SUMMARY");
		const summarize = mock.fn(async (_text: string) => "updated quasar summary");
		await memory.syncSession(
			createSessionSnapshot([first, createUserMessage("u2", "u1", "NEW_RAW_MARKER")]),
			summarize,
		);
		const input = summarize.mock.calls[0].arguments[0];
		assert.match(input, /PREVIOUS_SUMMARY/);
		assert.match(input, /NEW_RAW_MARKER/);
		assert.doesNotMatch(input, /OLD_RAW_MARKER/);
		const hits = memory.searchSummaries({ query: "quasar", topK: 5 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].text, "updated quasar summary");
		assert.equal(hits[0].location.entryId, "u2");
	});

	it("does not regenerate a summary or duplicate messages when no messages were appended", async () => {
		const state = createSessionSnapshot([createUserMessage("u1", null, "quasar")]);
		const summarize = mock.fn(async (_text: string) => "quasar");
		await memory.syncSession(state, summarize);
		await memory.syncSession(state, summarize);
		assert.equal(summarize.mock.callCount(), 1);
		assert.equal(memory.readMessages("session-a", "quasar").length, 1);
		assert.equal(memory.searchSummaries({ query: "quasar", topK: 10 }).length, 1);
	});

	it("reads the newest three matching user/assistant messages in a session", async () => {
		const root = createUserMessage("root", null, "needle root", 1);
		const left = createUserMessage("left", "root", "needle left", 2);
		const right = createUserMessage("right", "left", "needle right", 3);
		const [, answer, tool] = createConversation();
		answer.parentId = "right";
		await memory.syncSession(createSessionSnapshot([root, left, right, answer, tool]), async () => "summary");
		await memory.syncSession(
			createSessionSnapshot([createUserMessage("other", null, "needle", 6)], "session-b"),
			async () => "summary",
		);
		const hits = memory.readMessages("session-a", "needle");
		assert.deepEqual(
			hits.map((hit) => hit.entryId),
			["answer", "right", "left"],
		);
		assert.equal(hits[0].role, "assistant");
		assert.equal(hits[0].timestamp, answer.timestamp);
		assert.equal(hits[0].sourcePath, join(directory, "session-a.jsonl"));
		assert.deepEqual(memory.readMessages("missing-session", "needle"), []);
	});

	it("treats SQL wildcard characters in raw queries as literal substrings", async () => {
		const entries = [
			createUserMessage("literal", null, "key%_value"),
			createUserMessage("decoy", "literal", "keyXXvalue", 1),
		];
		await memory.syncSession(createSessionSnapshot(entries), async () => "summary");
		assert.deepEqual(
			memory.readMessages("session-a", "%_").map((hit) => hit.entryId),
			["literal"],
		);
		assert.deepEqual(memory.readMessages("session-a", "' OR 1=1 --"), []);
	});

	it("supports top-K and ascending BM25 scores without mixing unrelated summaries", async () => {
		for (const [sessionId, text] of [
			["session-a", "quasar"],
			["session-b", "quasar orbital deployment notes"],
			["session-c", "quasar orbital notes with additional background"],
			["session-d", "unrelated gardening notes"],
		]) {
			await memory.syncSession(
				createSessionSnapshot([createUserMessage("u1", null, text)], sessionId),
				async () => text,
			);
		}
		const hits = memory.searchSummaries({ query: "quasar", topK: 2 });
		assert.equal(hits.length, 2);
		assert.equal(hits[0].sourceId, "session-a");
		assert.ok(hits.every((hit) => hit.sourceId !== "session-d"));
		assert.ok(hits[0].score <= hits[1].score);
		assert.equal(memory.searchSummaries({ query: "quasar", topK: 1 }).length, 1);
		assert.deepEqual(memory.searchSummaries({ query: "absenttoken", topK: 5 }), []);
		assert.deepEqual(memory.searchSummaries({ query: "   ", topK: 5 }), []);
		assert.doesNotThrow(() => memory.searchSummaries({ query: 'quasar " OR (', topK: 5 }));
	});

	it("keeps the previous summary and checkpoint when an incremental summary fails", async () => {
		const first = createUserMessage("u1", null, "OLD_RAW");
		await memory.syncSession(createSessionSnapshot([first]), async () => "quasar previous");
		const entries = [first, createUserMessage("u2", "u1", "NEW_RAW", 1)];
		const summarize = mock.fn(async (_text: string): Promise<string> => {
			throw new Error("summary failed");
		});
		await assert.rejects(memory.syncSession(createSessionSnapshot(entries), summarize), /summary failed/);
		assert.equal(summarize.mock.callCount(), 1);
		assert.equal(memory.readMessages("session-a", "NEW_RAW").length, 1);
		const hits = memory.searchSummaries({ query: "quasar", topK: 5 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].text, "quasar previous");
		assert.equal(hits[0].location.entryId, "u1");
		// An explicit later sync must still include the message whose summary failed.
		const nextSummary = mock.fn(async (_text: string) => "quasar recovered");
		await memory.syncSession(createSessionSnapshot(entries), nextSummary);
		assert.match(nextSummary.mock.calls[0].arguments[0], /quasar previous/);
		assert.match(nextSummary.mock.calls[0].arguments[0], /NEW_RAW/);
		assert.equal(memory.searchSummaries({ query: "recovered", topK: 5 })[0].location.entryId, "u2");
	});

	it("retains memory after the database is reopened", async () => {
		await memory.syncSession(
			createSessionSnapshot([createUserMessage("u1", null, "quasar")]),
			async () => "quasar persisted",
		);
		db.close();
		db = openDatabase(join(directory, "nested", "index.db"));
		memory = new MemoryService(db);
		assert.equal(memory.searchSummaries({ query: "quasar", topK: 5 })[0].text, "quasar persisted");
		assert.equal(memory.readMessages("session-a", "quasar").length, 1);
	});
});
