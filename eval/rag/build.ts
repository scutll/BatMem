import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/storage/db.ts";
import { RAGService } from "../../src/rag/service.ts";
import type { CorpusRecord, DatasetLoader } from "./dataset.ts";
import { Progress } from "./progress.ts";

// Bump when stored chunk coordinates or FTS/tokenizer semantics change, not for retrieval-only edits.
const INDEX_FORMAT = "whole-record-v1:fts5-default";

export interface CorpusBuild {
	db: DatabaseSync;
	path: string;
	fingerprint: string;
	count: number;
	reused: boolean;
	/** Release both the content connection and its process-owned build lock. */
	close(): void;
}

/** Hash prepared IDs/text, independent of query split, topK, source paths and search implementation. */
export async function fingerprintCorpus(loader: DatasetLoader): Promise<{ fingerprint: string; count: number }> {
	const hash = createHash("sha256").update(INDEX_FORMAT);
	const progress = new Progress("校验语料");
	let count = 0;
	let complete = false;
	try {
		for await (const record of loader.readCorpus()) {
			hash.update(`${JSON.stringify([record.id, record.text])}\n`);
			progress.update(`已读取 ${++count} 条`);
		}
		if (!count) throw new Error("Empty corpus.");
		complete = true;
		return { fingerprint: hash.digest("hex"), count };
	} finally {
		progress.finish(`${complete ? "完成" : "失败"}；${count} 条`);
	}
}

/** Import one complete record per chunk. Reject duplicate IDs; return IDs for qrels validation. */
export async function indexCorpus(
	rag: RAGService,
	corpus: AsyncIterable<CorpusRecord>,
	expectedFingerprint?: string,
): Promise<Set<string>> {
	const ids = new Set<string>();
	const hash = createHash("sha256").update(INDEX_FORMAT);
	const progress = new Progress("导入语料");
	let complete = false;
	try {
		for await (const record of corpus) {
			if (ids.has(record.id)) throw new Error(`Duplicate corpus ID: ${record.id}`);
			ids.add(record.id);
			const text = record.text;
			hash.update(`${JSON.stringify([record.id, text])}\n`);
			rag.replaceDocumentIndex(
				{
					id: record.id,
					sourcePath: `dataset:${record.id}`,
					contentHash: createHash("sha256").update(text).digest("hex"),
					modifiedAt: new Date(0).toISOString(),
				},
				[{ text, chunkIndex: 0, startLine: 1, endLine: Math.max(1, text.replace(/\n$/, "").split("\n").length) }],
			);
			progress.update(`已入库 ${ids.size} 条`);
		}
		if (expectedFingerprint && hash.digest("hex") !== expectedFingerprint)
			throw new Error("Corpus changed during import; run again with a stable dataset.");
		complete = true;
		return ids;
	} finally {
		progress.finish(`${complete ? "完成" : "失败"}；${ids.size} 条`);
	}
}

/**
 * Reuse a completed corpus or rebuild an interrupted text import. Vectors are built only after this
 * checkpoint; interrupted embedding batches therefore survive subsequent runs without text replacement.
 * A separate SQLite lock connection serializes access and is released automatically on process death.
 * The content database never holds a write transaction while awaiting HTTP.
 */
export async function prepareCorpusBuild(
	loader: DatasetLoader,
	directory: string,
	fingerprint: string,
	count: number,
): Promise<CorpusBuild> {
	await mkdir(directory, { recursive: true });
	const lock = new DatabaseSync(join(directory, "build-lock.db"));
	let db: DatabaseSync | undefined;
	try {
		try {
			lock.exec("BEGIN IMMEDIATE");
		} catch (error) {
			throw new Error(`Index is in use by another evaluation: ${directory}`, { cause: error });
		}
		const path = join(directory, "index.db");
		db = openDatabase(path);
		db.exec(
			"CREATE TABLE IF NOT EXISTS eval_corpus (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL, count INTEGER NOT NULL)",
		);
		const saved = db.prepare("SELECT * FROM eval_corpus WHERE id = 1").get();
		if (saved && (saved.fingerprint !== fingerprint || Number(saved.count) !== count))
			throw new Error("Cached corpus identity differs; select a new build directory.");
		if (!saved) {
			// No text-ready checkpoint means embedding has not started for this build.
			db.exec("DELETE FROM documents");
			await indexCorpus(new RAGService(db, directory), loader.readCorpus(), fingerprint);
			db.prepare("INSERT INTO eval_corpus VALUES (1, ?, ?)").run(fingerprint, count);
		}
		const documents = Number(db.prepare("SELECT count(*) AS n FROM documents").get()!.n);
		const chunks = Number(db.prepare("SELECT count(*) AS n FROM chunks").get()!.n);
		if (documents !== count || chunks !== count)
			throw new Error("Cached corpus is incomplete; inspect the build database.");
		console.info(`[索引] ${saved ? "复用" : "已构建"} ${count} 条语料：${path}`);
		if (!saved)
			await writeFile(
				join(directory, "build-manifest.json"),
				JSON.stringify(
					{
						corpus_fingerprint: fingerprint,
						corpus_count: count,
						index_format: INDEX_FORMAT,
						index_path: path,
						status: "text-ready",
					},
					null,
					2,
				),
			);
		const connection = db;
		return {
			db: connection,
			path,
			fingerprint,
			count,
			reused: Boolean(saved),
			close() {
				try {
					connection.close();
				} finally {
					lock.close();
				}
			},
		};
	} catch (error) {
		try {
			db?.close();
		} finally {
			lock.close();
		}
		throw error;
	}
}
