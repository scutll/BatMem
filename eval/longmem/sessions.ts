import type { ImportedSession } from "./types.ts";
/**
 * 导入数据集数据，并构造SessionJSONL文件
 * 按照每个测试问题一个文件夹分隔，文件夹内是测试问题所需要的多个Session JSONL文件
 *
 *
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot } from "../../src/memory/types.ts";
import type { HistorySession } from "./dataset.ts";

/** Dataset dates lack a timezone. Interpret wall times as UTC for stable arithmetic, not as a claim about locale. */
export function parseHistoryDate(value: string): number {
	const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(value);
	if (!match) throw new Error(`Unsupported dataset date: ${value}`);
	const [, year, month, day, hour, minute] = match.map(Number);
	const timestamp = Date.UTC(year, month - 1, day, hour, minute);
	const date = new Date(timestamp);
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute
	)
		throw new Error(`Invalid dataset date: ${value}`);
	return timestamp;
}

/** Create one linear session. Zero assistant usage describes imported history, not real inference. */
export function createSessionEntries(history: HistorySession, cwd: string, sessionId = randomUUID()): FileEntry[] {
	const timestamp = parseHistoryDate(history.date);
	const iso = new Date(timestamp).toISOString();
	const entries: FileEntry[] = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp: iso, cwd },
	];
	let parentId: string | null = null;
	for (const message of history.messages) {
		const id = randomUUID();
		const entry: SessionMessageEntry = {
			type: "message",
			id,
			parentId,
			timestamp: iso,
			message:
				message.role === "user"
					? { role: "user", content: message.content, timestamp }
					: {
							role: "assistant",
							content: [{ type: "text", text: message.content }],
							timestamp,
							api: "openai-completions",
							provider: "imported-history",
							model: "unknown-historical-model",
							stopReason: "stop",
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
		entries.push(entry);
		parentId = id;
	}
	return entries;
}

/** Write completed files with opaque names: evidence-bearing dataset IDs never appear in Agent-visible paths. */
export async function writeHistorySessions(
	histories: HistorySession[],
	directory: string,
	cwd: string,
): Promise<ImportedSession[]> {
	await mkdir(directory, { recursive: true });
	const imported: ImportedSession[] = [];
	for (const history of histories) {
		const id = randomUUID();
		const path = join(directory, `${id}.jsonl`);
		const entries = createSessionEntries(history, cwd, id);
		const serialized = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		await writeFile(path, serialized, { flag: "wx" });
		const snapshot = loadSessionSnapshot(path);
		if (snapshot.sessionId !== id || JSON.stringify(snapshot.entries) !== JSON.stringify(entries.slice(1)))
			throw new Error(`Session round-trip changed messages: ${id}`);
		imported.push({
			originalId: history.id,
			sessionId: id,
			path,
			messageCount: history.messages.length,
			sha256: createHash("sha256").update(serialized).digest("hex"),
		});
	}
	return imported;
}

/** Use Pi's loader; the memory service consumes a snapshot and never parses JSONL itself. */
export function loadSessionSnapshot(path: string): SessionSnapshot {
	const manager = SessionManager.open(path);
	return {
		sessionId: manager.getSessionId(),
		sourcePath: path,
		projectPath: manager.getCwd(),
		entries: manager.getEntries(),
	};
}
