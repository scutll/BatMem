import assert from "node:assert/strict";
import {
	appendFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/storage/db.ts";
import { RAGService } from "../src/rag/service.ts";

describe("Markdown retrieval", () => {
	let directory: string;
	let documents: string;
	let db: DatabaseSync;
	let rag: RAGService;
	let fixturePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "batmem-rag-"));
		documents = join(directory, "documents");
		const project = fileURLToPath(new URL("../", import.meta.url));
		const originals = join(project, "testDocs");
		try {
			await cp(originals, documents, { recursive: true, errorOnExist: true });
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// Until testDocs is supplied, exercise a copy of the existing long design document.
			await mkdir(documents, { recursive: true });
			await cp(join(project, "docs", "Memories.md"), join(documents, "design.md"));
		}
		const files = (await readdir(documents, { recursive: true }))
			.filter((path) => path.toLowerCase().endsWith(".md"))
			.sort();
		assert.ok(files.length > 0, "testDocs must contain at least one Markdown document");
		fixturePath = join(documents, files[0]);
		db = openDatabase(join(directory, "index.db"));
		rag = new RAGService(db, documents);
	});

	afterEach(async () => {
		db?.close();
		await rm(directory, { recursive: true, force: true });
	});

	it("recursively indexes Markdown, ignores other files and returns read-compatible locations", async () => {
		await mkdir(join(documents, "nested"), { recursive: true });
		const sourcePath = join(documents, "nested", "guide.md");
		await writeFile(sourcePath, "# Deployment\nbatmemtestquasar deployment instructions\n");
		await writeFile(join(documents, "ignored.txt"), "batmemtestquasar ignored");
		await rag.scanDocuments();
		const hits = rag.searchChunks({ query: "batmemtestquasar", topK: 5 });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].sourceType, "document");
		assert.ok(hits[0].sourceId);
		assert.equal(hits[0].location.sourcePath, sourcePath);
		assert.equal(hits[0].location.startLine, 1);
		assert.equal(hits[0].location.endLine, 2);
		assert.equal(hits[0].location.chunkIndex, 0);
		assert.match(hits[0].text, /batmemtestquasar deployment/);
	});

	it("returns indexed long-document text with accurate source line ranges", async () => {
		await appendFile(fixturePath, "\nlocationuniquetoken\n");
		await rag.scanDocuments();
		const content = await readFile(fixturePath, "utf8");
		const lines = content.split("\n");
		const hits = rag.searchChunks({ query: "locationuniquetoken", topK: 10 });
		assert.ok(hits.length > 0);
		for (const hit of hits) {
			assert.equal(hit.location.sourcePath, fixturePath);
			assert.ok(hit.text.length <= 500);
			assert.ok(content.includes(hit.text));
			assert.ok(
				lines
					.slice(hit.location.startLine - 1, hit.location.endLine)
					.map((line) => `${line}\n`)
					.join("")
					.includes(hit.text),
			);
		}
	});

	it("indexes a newly added copy without losing existing documents", async () => {
		await appendFile(fixturePath, "\nexistinguniquetoken\n");
		await rag.scanDocuments();
		const added = join(documents, "added", "copy.md");
		await mkdir(dirname(added));
		await cp(fixturePath, added);
		await appendFile(added, "\naddeduniquetoken\n");
		await rag.scanDocuments();
		const hits = rag.searchChunks({ query: "addeduniquetoken", topK: 10 });
		assert.ok(hits.length > 0);
		assert.ok(hits.every((hit) => hit.location.sourcePath === added));
		assert.ok(
			rag
				.searchChunks({ query: "existinguniquetoken", topK: 100 })
				.some((hit) => hit.location.sourcePath === fixturePath),
		);
	});

	it("keeps result identities stable when unchanged files are scanned again", async () => {
		await appendFile(fixturePath, "\nbatmemtestquasar original\n");
		await rag.scanDocuments();
		const before = rag.searchChunks({ query: "batmemtestquasar", topK: 5 });
		await rag.scanDocuments();
		assert.deepEqual(rag.searchChunks({ query: "batmemtestquasar", topK: 5 }), before);
	});

	it("detects content changes even when size and modification time stay the same", async () => {
		const path = fixturePath;
		await appendFile(path, "\nbatmemtestquasar batmemtestoldtoken\n");
		const original = await stat(path);
		await rag.scanDocuments();
		const sourceId = rag.searchChunks({ query: "batmemtestoldtoken", topK: 5 })[0].sourceId;
		const content = await readFile(path, "utf8");
		await writeFile(path, content.replace("batmemtestoldtoken", "batmemtestnewtoken"));
		await utimes(path, original.atime, original.mtime);
		await rag.scanDocuments();
		assert.deepEqual(rag.searchChunks({ query: "batmemtestoldtoken", topK: 5 }), []);
		const hits = rag.searchChunks({ query: "batmemtestnewtoken", topK: 5 });
		assert.ok(hits.length > 0);
		assert.ok(hits.every((hit) => hit.sourceId === sourceId));
	});

	it("removes deleted document chunks from full-text search", async () => {
		const path = fixturePath;
		await appendFile(path, "\nbatmemtestquasar batmemtestdeletedtoken\n");
		await rag.scanDocuments();
		await rm(path);
		await rag.scanDocuments();
		assert.deepEqual(rag.searchChunks({ query: "batmemtestdeletedtoken", topK: 5 }), []);
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE source_path = ?").get(path)?.count, 0);
		assert.equal(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM chunks c LEFT JOIN documents d ON c.document_id = d.id WHERE d.id IS NULL",
				)
				.get()?.count,
			0,
		);
	});

	it("does not purge the index when the document directory cannot be scanned", async () => {
		await appendFile(fixturePath, "\nbatmemtestquasar batmemtestpreserved\n");
		await rag.scanDocuments();
		await rename(documents, join(directory, "temporarily-unavailable"));
		await assert.rejects(rag.scanDocuments());
		assert.ok(rag.searchChunks({ query: "batmemtestpreserved", topK: 5 }).length > 0);
	});

	it("limits results, orders BM25 relevance descending and handles empty or malformed queries", async () => {
		await writeFile(join(documents, "short.md"), "batmemtestquasar");
		await writeFile(join(documents, "long.md"), "batmemtestquasar orbital deployment background notes");
		await rag.scanDocuments();
		const hits = rag.searchChunks({ query: "batmemtestquasar", topK: 5 });
		assert.equal(hits.length, 2);
		assert.equal(hits[0].location.sourcePath, join(documents, "short.md"));
		assert.ok(hits.every((hit) => Number.isFinite(hit.score)));
		assert.ok(hits[0].score >= hits[1].score);
		assert.equal(rag.searchChunks({ query: "batmemtestquasar", topK: 1 }).length, 1);
		assert.deepEqual(rag.searchChunks({ query: "batmemtestabsenttoken", topK: 5 }), []);
		assert.deepEqual(rag.searchChunks({ query: "  ", topK: 5 }), []);
		assert.doesNotThrow(() => rag.searchChunks({ query: 'batmemtestquasar " OR (', topK: 5 }));
	});

	it("retains indexed documents after the database is reopened", async () => {
		await appendFile(fixturePath, "\nbatmemtestquasar batmemtestpersisted\n");
		await rag.scanDocuments();
		db.close();
		db = openDatabase(join(directory, "index.db"));
		rag = new RAGService(db, documents);
		assert.match(
			rag.searchChunks({ query: "batmemtestpersisted", topK: 5 })[0].text,
			/batmemtestquasar batmemtestpersisted/,
		);
	});
});
