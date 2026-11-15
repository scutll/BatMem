import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createSessionEntries, loadSessionSnapshot, parseHistoryDate, writeHistorySessions } from "../sessions.ts";

it("round-trips complete Pi sessions with original roles, text, timestamps and a linear parent chain", async () => {
	const root = await mkdtemp(join(tmpdir(), "batmem-session-"));
	try {
		const history = {
			id: "answer-evidence-id",
			date: "2023/05/20 (Sat) 02:21",
			messages: [
				{ role: "user" as const, content: '第一条\nquote: "hello"' },
				{ role: "assistant" as const, content: "Reply" },
			],
		};
		const imported = await writeHistorySessions([history], root, root);
		assert.ok(!imported[0].path.includes(history.id));
		const snapshot = loadSessionSnapshot(imported[0].path);
		assert.equal(snapshot.sessionId, imported[0].sessionId);
		assert.equal(snapshot.entries.length, 2);
		const [first, second] = snapshot.entries;
		assert.equal(first.parentId, null);
		assert.equal(second.parentId, first.id);
		assert.equal(first.timestamp, "2023-05-20T02:21:00.000Z");
		assert.equal(first.type, "message");
		if (first.type !== "message" || second.type !== "message") throw new Error("Expected messages.");
		if (first.message.role !== "user") throw new Error("Expected user.");
		assert.equal(first.message.content, history.messages[0].content);
		assert.equal(first.message.timestamp, Date.UTC(2023, 4, 20, 2, 21));
		assert.equal(second.message.role, "assistant");
		if (second.message.role !== "assistant") throw new Error("Expected assistant.");
		assert.deepEqual(second.message.content, [{ type: "text", text: "Reply" }]);
		assert.equal(second.message.usage.totalTokens, 0);
		assert.ok((await readFile(imported[0].path, "utf8")).endsWith("\n"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects invalid dates and preserves same-session times without fabricating message offsets", () => {
	assert.throws(() => parseHistoryDate("2023/02/30 (Thu) 12:00"), /Invalid/);
	assert.throws(() => parseHistoryDate("2023-05-20"), /Unsupported/);
	const entries = createSessionEntries(
		{
			id: "s",
			date: "2023/05/20 (Sat) 02:21",
			messages: [
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
			],
		},
		"project",
	);
	assert.equal(entries[1].timestamp, entries[2].timestamp);
});
