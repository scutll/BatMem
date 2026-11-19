import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CorpusRecord, DatasetLoader, EvaluationQuery } from "./types.ts";

/** Adapt a local BEIR directory to the format-independent retrieval evaluation contract. */
export class BeirDataset implements DatasetLoader {
	readonly name: string;
	readonly split: string;
	readonly indexing = "one corpus record per chunk; nonempty title and text joined by newline";
	readonly sourceFiles: readonly string[];
	readonly implementationFiles = [new URL(import.meta.url)];

	/** Select one qrels split; reject path separators in split names. No files are read until loading. */
	constructor(directory: string, split = "test") {
		if (!/^[a-zA-Z0-9_-]+$/.test(split)) throw new Error("Invalid split name.");
		this.name = resolve(directory);
		this.split = split;
		this.sourceFiles = [
			join(this.name, "corpus.jsonl"),
			join(this.name, "queries.jsonl"),
			join(this.name, "qrels", `${split}.tsv`),
		];
	}

	/** Preserve corpus IDs and prepare title/body text. Each record remains a single retrieval unit. */
	async *readCorpus(): AsyncGenerator<CorpusRecord> {
		for await (const row of readRecords(this.sourceFiles[0])) {
			yield { id: row.id, text: [row.title, row.text].filter(Boolean).join("\n") };
		}
	}

	/** Associate queries with this split's judgments, excluding queries with no judgments. */
	loadQueries(): Promise<EvaluationQuery[]> {
		return loadQueries(this.sourceFiles[1], this.sourceFiles[2]);
	}
}

/**
 * Stream JSONL without loading the corpus into memory. Report malformed rows with their source line.
 * Blank lines are ignored. BEIR identifiers must be nonempty strings; duplicates are rejected by the runner.
 */
export async function* readRecords(path: string): AsyncGenerator<{ id: string; text: string; title: string }> {
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let lineNumber = 0;
	try {
		for await (const line of lines) {
			lineNumber++;
			if (!line.trim()) continue;
			const row: unknown = JSON.parse(line);
			if (
				!row ||
				typeof row !== "object" ||
				!("_id" in row) ||
				typeof row._id !== "string" ||
				!row._id ||
				!("text" in row) ||
				typeof row.text !== "string" ||
				("title" in row && typeof row.title !== "string")
			)
				throw new Error("Expected string _id, text and optional title.");
			yield { id: row._id, text: row.text, title: "title" in row ? String(row.title) : "" };
		}
	} catch (error) {
		throw new Error(`${path}:${lineNumber}: ${String(error)}`, { cause: error });
	} finally {
		lines.close();
		input.destroy();
	}
}

/** Read one BEIR split, keeping only queries present in its qrels. Missing query references are errors. */
export async function loadQueries(queriesPath: string, qrelsPath: string): Promise<EvaluationQuery[]> {
	const queries = new Map<string, EvaluationQuery>();
	for await (const row of readRecords(queriesPath)) {
		if (queries.has(row.id)) throw new Error(`Duplicate query ID: ${row.id}`);
		queries.set(row.id, { id: row.id, text: row.text, qrels: Object.create(null) });
	}
	const input = createReadStream(qrelsPath, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let lineNumber = 0;
	try {
		for await (const line of lines) {
			lineNumber++;
			if (lineNumber === 1) {
				if (line.replace(/^\uFEFF/, "").trim() !== "query-id\tcorpus-id\tscore")
					throw new Error("Invalid qrels header.");
				continue;
			}
			if (!line.trim()) continue;
			const fields = line.split("\t");
			const [queryId, documentId, grade] = fields;
			if (fields.length !== 3 || !queryId || !documentId || !grade.trim() || !Number.isSafeInteger(Number(grade))) {
				throw new Error(`Invalid qrels row ${lineNumber}.`);
			}
			const query = queries.get(queryId);
			if (!query) throw new Error(`Unknown query ID: ${queryId}`);
			if (Object.hasOwn(query.qrels, documentId)) throw new Error(`Duplicate qrel: ${queryId}/${documentId}`);
			query.qrels[documentId] = Number(grade);
		}
	} finally {
		lines.close();
		input.destroy();
	}
	const selected = [...queries.values()].filter((query) => Object.keys(query.qrels).length);
	if (!selected.length) throw new Error("No queries with judgments in this split.");
	return selected;
}
