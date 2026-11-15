# BatMem

BatMem allows agent to build a strong cross-session reasoning capability and become a acknowledge-powerful professior. Excelling in extracting most valuable infomation from tons of documents from all kinds.

## Project Structure

```text
BatMem/
├── docs/
│   ├── Eval.md
│   ├── Memories.md
│   ├── Notes-LongMemEval.md
│   ├── message-session-lifecycle.zh-CN.md
│   └── test.md
├── eval/
│   ├── longmem/
│   │   ├── test/
│   │   ├── dataset.ts
│   │   ├── judge-prompts.json
│   │   ├── judge.ts
│   │   ├── longmemeval.ts
│   │   ├── pi.ts
│   │   ├── runner.ts
│   │   ├── run.ts
│   │   ├── runlongmem.ps1
│   │   └── sessions.ts
│   └── rag/
│       ├── test/
│       ├── beir.ts
│       ├── dataset.ts
│       ├── run.ts
│       ├── runbeir.ps1
│       ├── runner.ts
│       ├── score_rag.py
│       └── requirements.txt
├── src/
│   ├── chunker.ts
│   ├── db.ts
│   ├── index.ts
│   ├── memory.ts
│   ├── rag.ts
│   ├── summary.ts
│   └── types.ts
├── test/
│   ├── CONTRACT.md
│   ├── chunker.test.ts
│   ├── memory.test.ts
│   └── rag.test.ts
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```
