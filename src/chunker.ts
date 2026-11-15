import type { DocumentChunk } from "./types.ts";

/**
 * Split Markdown into source-preserving slices: at most 500 UTF-16 code units, overlapping by 100.
 * Counts JavaScript string positions, not bytes, tokens or grapheme clusters; preserves newline sequences.
 *
 * @param content Original decoded Markdown text.
 * @returns Zero-based chunks with one-based inclusive lines and the active ATX heading at each start.
 * Empty input returns []; a terminal newline adds no covered line, and no overlap-only tail is emitted.
 * Heading recognition excludes fenced code; it is not a full Markdown parser (e.g. no Setext headings).
 */
export function chunkMarkdown(content: string): DocumentChunk[] {
	// Precompute source coordinates once, then advance monotonically through them while emitting chunks.
	const lineStarts = [0];
	const headings: { offset: number; title: string }[] = [];
	let offset = 0;
	let fence: { character: string; length: number } | undefined;
	for (const line of content.split("\n")) {
		// Fence character and minimum opening length distinguish example headings from document headings.
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker) {
			if (!fence) fence = { character: marker[1][0], length: marker[1].length };
			else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim())
				fence = undefined;
		} else if (!fence) {
			const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
			if (heading) headings.push({ offset, title: heading[1] });
		}
		offset += line.length + 1;
		// A final newline terminates the previous line rather than adding an empty covered line.
		if (offset < content.length) lineStarts.push(offset);
	}

	const chunks: DocumentChunk[] = [];
	let startLine = 0;
	let endLine = 0;
	let headingIndex = -1;
	for (let start = 0; start < content.length; start += 400) {
		const end = Math.min(start + 500, content.length);
		while (startLine + 1 < lineStarts.length && lineStarts[startLine + 1] <= start) startLine++;
		while (endLine + 1 < lineStarts.length && lineStarts[endLine + 1] < end) endLine++;
		while (headingIndex + 1 < headings.length && headings[headingIndex + 1].offset <= start) headingIndex++;
		chunks.push({
			text: content.slice(start, end),
			chunkIndex: chunks.length,
			startLine: startLine + 1,
			endLine: endLine + 1,
			section: headings[headingIndex]?.title,
		});
		if (end === content.length) break;
	}
	return chunks;
}
