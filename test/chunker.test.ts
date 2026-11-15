import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkMarkdown } from "../src/chunker.ts";

describe("Markdown chunking", () => {
	it("returns no chunks for an empty document", () => {
		assert.deepEqual(chunkMarkdown(""), []);
	});

	it("preserves a short document and numbers chunks from zero", () => {
		const chunks = chunkMarkdown("first line\nsecond line\n");
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].text, "first line\nsecond line\n");
		assert.equal(chunks[0].chunkIndex, 0);
		assert.equal(chunks[0].startLine, 1);
		assert.equal(chunks[0].endLine, 2);
	});

	it("uses 500-character chunks with 100-character overlap and correct line ranges", () => {
		// Each line occupies 100 characters including its separator, except the last.
		const text = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(97)}`).join(
			"\n",
		);
		const chunks = chunkMarkdown(text);
		assert.equal(text.length, 1199);
		assert.deepEqual(
			chunks.map((chunk) => chunk.text),
			[text.slice(0, 500), text.slice(400, 900), text.slice(800)],
		);
		assert.deepEqual(
			chunks.map((chunk) => chunk.chunkIndex),
			[0, 1, 2],
		);
		assert.deepEqual(
			chunks.map((chunk) => [chunk.startLine, chunk.endLine]),
			[
				[1, 5],
				[5, 9],
				[9, 12],
			],
		);
		assert.equal(chunks[0].text.slice(-100), chunks[1].text.slice(0, 100));
		assert.equal(chunks[1].text.slice(-100), chunks[2].text.slice(0, 100));
	});

	for (const [length, expectedLengths] of [
		[499, [499]],
		[500, [500]],
		[501, [500, 101]],
		[900, [500, 500]],
		[901, [500, 500, 101]],
	] as const) {
		it(`handles a ${length}-character boundary without redundant overlap-only chunks`, () => {
			const chunks = chunkMarkdown("x".repeat(length));
			assert.deepEqual(
				chunks.map((chunk) => chunk.text.length),
				[...expectedLengths],
			);
			assert.ok(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1));
		});
	}

	it("counts blank lines and CRLF separators in source locations", () => {
		const text = "first\r\n\r\nthird\r\n";
		const chunks = chunkMarkdown(text);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0].text, text);
		assert.equal(chunks[0].startLine, 1);
		assert.equal(chunks[0].endLine, 3);
	});

	it("carries the active heading into chunks that begin inside its section", () => {
		const text = `# Deployment\n${"x".repeat(1000)}`;
		const chunks = chunkMarkdown(text);
		assert.equal(chunks.length, 3);
		assert.ok(chunks.every((chunk) => chunk.section === "Deployment"));
	});

	it("changes section metadata when a chunk starts in a later section", () => {
		// Make the second heading begin exactly at the second chunk's offset (400).
		const prefix = "# First\n";
		const text = `${prefix}${"x".repeat(400 - prefix.length - 1)}\n## Second\n${"y".repeat(600)}`;
		const chunks = chunkMarkdown(text);
		assert.equal(chunks[0].section, "First");
		assert.equal(chunks[1].section, "Second");
		assert.equal(chunks[2].section, "Second");
	});

	it("does not treat fenced code headings as document sections", () => {
		const text = `# Real section\n\n\`\`\`md\n# Example heading\n\`\`\`\n${"x".repeat(600)}`;
		const chunks = chunkMarkdown(text);
		assert.ok(chunks.every((chunk) => chunk.section === "Real section"));
	});
});
