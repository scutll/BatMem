# Test-first contract

These tests specify the service implementation. All 29 cases run against the
production chunker and temporary SQLite databases. No tests are skipped and no
production behavior is mocked except the summary model call. The three test
files cover underlying services, not real provider calls or the interactive UI.

Run from this directory's parent (`.pi/extensions/BatMem`):

```sh
node --test test/memory.test.ts test/rag.test.ts test/chunker.test.ts
```

## Public contracts

- `openDatabase(path)` returns a synchronous `node:sqlite` database connection,
  creates parent directories and initializes tables and FTS5 indexes.
- `new MemoryService(db)` exposes `syncSession(snapshot, summarize)`,
  `searchSummaries(query)`, and `readMessages(sessionId, keyword)`.
- A snapshot contains `sessionId`, `sourcePath`, `projectPath`, and `entries`.
  Entries use the existing session entry format. Each session is one linear
  conversation; branch selection and ancestor lookup are out of scope.
- `summarize(text)` returns `Promise<string>`. Its text includes either the full
  conversation or the previous summary followed by new messages after the saved entry.
- `new RAGService(db, documentsDirectory)` exposes asynchronous `scanDocuments()` and
  synchronous `searchChunks(query)`.
- Searches accept `{ query, topK }`. Empty input returns no results; user input is treated as text,
  not trusted FTS syntax. Both services return ascending native BM25 scores.
- Search hits contain `text`, `score`, `sourceType` (`memory` or `document`),
  `sourceId`, and `location`. Memory locations contain `entryId` (summary leaf)
  and `sourcePath`. Document locations contain `sourcePath`, `startLine`,
  `endLine`, and zero-based `chunkIndex`. Line numbers are one-based and inclusive;
  a trailing newline does not create an extra covered line.
- `memory.readMessages()` returns messages containing `entryId`, `role`, `text`,
  `timestamp`, and `sourcePath`, newest first. Keywords are literal substrings.
- Chunking stops once a chunk reaches the end, without emitting a redundant
  overlap-only chunk. Tests use ASCII to isolate chunk boundaries from future
  Unicode character-counting choices.
- `chunkMarkdown(text)` returns chunks with `text`, `chunkIndex`, `startLine`,
  `endLine`, and `section`. Section is the active heading title at the chunk's
  start, or the first heading when a chunk starts with that heading. Fenced code
  does not introduce document headings.

The few structural SQL assertions assume `documents(id, source_path)` and
`chunks(document_id)`. They verify removal of deleted documents and orphan rows.
Retrieval assertions use real FTS5 queries, not fake search results.

RAG tests copy `testDocs` into a temporary directory before changing any files.
Until that directory is supplied, they use a copy of `docs/Memories.md` instead.
An existing but empty `testDocs` is an error. Exact chunk boundaries are tested
separately in `chunker.test.ts` with deterministic short inputs.

All test data lives in temporary directories. Tests do not read real sessions,
write project indexes, load extensions into the agent, or make model requests.
No external dependencies are added in this test-only step.
