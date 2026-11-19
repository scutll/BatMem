/**
 * 对LongMemEval提供的数据集进行数据转换，适配成HistorySession
 */

import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import type { HistoryMessage, MemoryDatasetLoader, MemorySample } from "./types.ts";

export const LONG_MEM_EVAL_QUESTION_TYPES = new Set([
	"single-session-user",
	"single-session-assistant",
	"single-session-preference",
	"multi-session",
	"temporal-reasoning",
	"knowledge-update",
]);

/** Read the released JSON array one object at a time; memory stays bounded to one sample. */
export class LongMemEvalDataset implements MemoryDatasetLoader {
	readonly sourcePath: string;
	constructor(path: string) {
		this.sourcePath = resolve(path);
	}

	/** Strictly validate array framing and sample fields; do not silently drop malformed samples. */
	async *readSamples(): AsyncGenerator<MemorySample> {
		let phase: "start" | "first" | "value" | "comma" | "end" = "start";
		let depth = 0;
		let inString = false;
		let escaped = false;
		let value = "";
		const seen = new Set<string>();
		for await (const chunk of createReadStream(this.sourcePath, { encoding: "utf8" })) {
			for (const char of chunk) {
				if (depth) {
					value += char;
					if (inString) {
						if (escaped) escaped = false;
						else if (char === "\\") escaped = true;
						else if (char === '"') inString = false;
					} else if (char === '"') inString = true;
					else if (char === "{" || char === "[") depth++;
					else if (char === "}" || char === "]") depth--;
					if (!depth) {
						const sample = parseSample(JSON.parse(value));
						if (seen.has(sample.id)) throw new Error(`Duplicate question ID: ${sample.id}`);
						seen.add(sample.id);
						value = "";
						phase = "comma";
						yield sample;
					}
					continue;
				}
				if (/\s|\uFEFF/.test(char)) continue;
				if (phase === "start" && char === "[") phase = "first";
				else if ((phase === "first" || phase === "comma") && char === "]") phase = "end";
				else if (phase === "comma" && char === ",") phase = "value";
				else if ((phase === "first" || phase === "value") && char === "{") {
					value = "{";
					depth = 1;
				} else throw new Error(`Invalid dataset array framing near ${char}`);
			}
		}
		if (depth || phase !== "end") throw new Error("Truncated dataset JSON array.");
	}
}

/** Validate source records, then explicitly project allowed fields to remove has_answer and other labels. */
export function parseSample(value: unknown): MemorySample {
	if (!value || typeof value !== "object") throw new Error("Expected a LongMemEval object.");
	const row = value as Record<string, unknown>;
	for (const key of ["question_id", "question", "question_date", "question_type"]) {
		if (typeof row[key] !== "string" || !(row[key] as string).trim()) throw new Error(`Invalid ${key}`);
	}
	// Counting questions use numeric references in the released dataset; Judge prompts consume text.
	if (
		!(typeof row.answer === "string" && row.answer.trim()) &&
		!(typeof row.answer === "number" && Number.isFinite(row.answer))
	)
		throw new Error(`Invalid answer in question ${row.question_id}.`);
	if (!LONG_MEM_EVAL_QUESTION_TYPES.has(String(row.question_type))) throw new Error(`Unknown question type: ${row.question_type}`);
	const {
		haystack_sessions: sessions,
		haystack_dates: dates,
		haystack_session_ids: ids,
		answer_session_ids: evidence,
	} = row;
	if (
		!Array.isArray(sessions) ||
		!sessions.length ||
		!Array.isArray(dates) ||
		!Array.isArray(ids) ||
		!Array.isArray(evidence) ||
		sessions.length !== dates.length ||
		sessions.length !== ids.length ||
		!dates.every((date: unknown) => typeof date === "string") ||
		!ids.every((id: unknown) => typeof id === "string" && id.length > 0) ||
		!evidence.every((id: unknown) => typeof id === "string")
	)
		throw new Error(`Invalid history arrays in question ${row.question_id}.`);
	// Released samples can repeat source IDs with different dates. Preserve every occurrence;
	// writeHistorySessions assigns each occurrence an independent Pi session UUID.
	const histories = sessions.map((session: unknown, index: number) => {
		if (!Array.isArray(session) || !session.length) throw new Error("Empty history session.");
		const messages: HistoryMessage[] = session.map((message: unknown) => {
			if (
				!message ||
				typeof message !== "object" ||
				!("role" in message) ||
				!("content" in message) ||
				(message.role !== "user" && message.role !== "assistant") ||
				typeof message.content !== "string"
			)
				throw new Error("Invalid history message.");
			return { role: message.role, content: message.content };
		});
		return { id: String(ids[index]), date: String(dates[index]), messages };
	});
	const abstention = String(row.question_id).includes("_abs");
	if (!abstention && !evidence.every((id: unknown) => ids.includes(id)))
		throw new Error("Evidence session missing from history.");
	return {
		id: String(row.question_id),
		question: String(row.question),
		date: String(row.question_date),
		type: String(row.question_type),
		abstention,
		histories,
		reference: { answer: String(row.answer), sessionIds: evidence.map(String) },
	};
}
