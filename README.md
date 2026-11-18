# BatMem

BatMem allows agent to build a strong cross-session reasoning capability and become a acknowledge-powerful professior. Excelling in extracting most valuable infomation from tons of documents from all kinds.

## Embedding Configuration

当前通过 Jina HTTP API 生成 embedding，默认使用 `jina-embeddings-v3`、1024 维。Pi 扩展和 RAG eval 都读取 **BatMem 根目录的 `.env`**，不使用 Pi 的聊天模型密钥。

在 BatMem 目录安装依赖（包含 sqlite-vec）：

```powershell
npm ci --ignore-scripts
```

首次配置时，将 `.env.example` 复制为 `.env`（已有 `.env` 时直接编辑）：

```powershell
Copy-Item .env.example .env
```

从 [Jina](https://jina.ai/) 获取 API Key，填写 `.env`：

```dotenv
JINA_API_KEY=your-jina-api-key
HTTPS_PROXY=http://127.0.0.1:7890
```

然后在需要使用记忆的项目目录启动 `pi`，确保 BatMem 扩展已加载。修改 `.env` 后重新启动 Pi；无论从哪个项目启动，配置文件都固定在 BatMem 根目录。

`.env` 中的值优先于同名进程环境变量；缺少的配置项可从进程环境变量读取。`JINA_API_KEY=` 留空会停用 embedding。代理优先读取 `HTTPS_PROXY`，其次 `HTTP_PROXY`，显式留空表示不使用 BatMem 专属代理。代理软件需要保持运行，不需要设置 `NODE_USE_ENV_PROXY`；该代理仅用于 Jina 请求，不修改 Pi 的全局 HTTP 配置。`.env` 已由 Git 忽略，仓库只提交 `.env.example`。

`UND_ERR_CONNECT_TIMEOUT` 表示连接超时，应先检查代理和网络，不需要删除数据库。

Embedding 每次请求超时为 10 秒；网络错误、超时及 HTTP 408/429/5xx 最多立即重试 3 次（共最多 4 次请求）。鉴权、输入错误和无效响应不重试。重试耗尽后停止当前操作，已保存的向量批次保留。

配置密钥后，启动时会补建已有 Session Summary 和文档 Chunk 的缺失向量，后续会话摘要更新后也会同步向量。这些操作会将对应文本发送给 Jina，并产生 API 用量。已完成且正文未变化的向量不会重复生成。

| 配置项 | 当前值 |
| --- | --- |
| HTTP endpoint | `https://api.jina.ai/v1/embeddings` |
| 模型 / 维度 | `jina-embeddings-v3` / `1024` |
| 文档和摘要编码任务 | `retrieval.passage` |
| 查询编码任务 | `retrieval.query` |
| Markdown 目录 | 项目下的 `.pi/docs-memory/documents` |
| 文本与向量数据库 | 项目下的 `.pi/docs-memory/index.db` |

`.env` 当前配置密钥和代理；模型和维度不通过 `.env` 配置。超长输入会报错，不会静默截断。

### Search Mode

`memory_search` 和 `rag_search` 工具都接受 `mode`：

| mode | 行为 |
| --- | --- |
| `search`（默认） | BM25 关键词检索，不需要 embedding 密钥 |
| `vsearch` | 向量语义检索，需要密钥及完整的向量索引 |
| `query` | 并发召回 BM25 与 embedding；当前 Processor 直接返回 embedding hits，需要完整向量索引 |

例如，让 Agent 使用 `rag_search` 并指定以下参数：

```json
{ "query": "如何恢复上次任务的进度", "topK": 5, "mode": "vsearch" }
```

设置密钥不会自动将默认检索切换为向量搜索；自动注入历史摘要仍使用 BM25。显式 `vsearch` 遇到模型失败或索引未完成时会报错，不会偷偷降级。已完成的向量批次会保留，后续同步可以补建缺失部分。

如需停用 embedding，将 `.env` 中的密钥设置为 `JINA_API_KEY=` 后重新启动 Pi；已有文本和向量不会被删除。

### RAG Evaluation

填写 `.env` 后，从 BatMem 目录运行；将数据集路径替换为本地 BEIR 目录，输出目录必须尚不存在：

```powershell
node eval/rag/run.ts --dataset "<BEIR目录>" --output "eval/rag/runs/vector-01" --mode vsearch --top-k 10
```

BM25 对照实验使用 `--mode search` 和另一个输出目录。两种模式都导出相同格式的 `retrieval.jsonl`，供现有 Python 评分程序读取，具体评分方式见 [Eval.md](docs/Eval.md)。

双路召回使用 `--mode query`，PowerShell 使用 `-Mode query`；LongMemEval 使用 `--retrieval query` 或 `-Retrieval query`。当前 query 不融合、不重排，输出与相同配置的 vsearch 一致。两路均成功后才进入 Processor，任一路失败会等待全部路径结束再报错，不降级。

CLI 默认把可复用索引保存在 `eval/rag/builds/<语料指纹>/index.db`。同一语料首次完整生成文档向量，后续运行复用；中断后换一个新的输出目录重跑，会补建缺失向量。改变 Top-K 或 split 不重建语料向量，查询文本仍在每次运行时编码。可通过 `--builds` 更改缓存根目录。

准备好 Python 评分环境后，也可以一键检索、评分并显示中文指标：

```powershell
.\eval\rag\runbeir.ps1 "<BEIR目录>" -Mode vsearch -TopK 10
```

过程显示阶段提示和单行刷新进度；输出重定向到文件时改为间隔日志。每次评测结果单独保存到 `eval/rag/runs/`，不会覆盖上一轮结果。

## Query 运行架构（待实现）

当前可运行模式为 `search` 和 `vsearch`。计划中的 `query` 在公共搜索入口中组合 Recall 与 Processor：Recall 并行执行已注册的全部召回任务，汇总后一次性交给 Processor，最终仍返回 `RetrievalHit[]`。召回后的处理逻辑留空。

```text
工具 / Eval → SearchService.query({ query, topK })
  → QueryRecall 抽象类的具体实现
      ├─ RecallTask { path: "bm25", run: async (request) => ... }
      ├─ RecallTask { path: "embedding", run: async (request) => ... }
      └─ 其他已注册的 RecallTask
      → 并行运行，等待全部路径结束
      → 汇总 [{ path, hits }, ...]，保留空结果及各路径排名
  → QueryProcessor.process(原始请求, 全部路径结果)
      → 处理逻辑：留空
  → RetrievalHit[] → 工具结果 / Eval 导出
```

### 设置召回任务的 run

`QueryRecall` 是抽象类，负责 `addTask()`、任务执行和结果汇总，不固定召回算法或路径数量。具体实现类在构造时注册任务，每条路径使用唯一名称。下面是初始双路组合的设计示例，相关类尚未实现：

```ts
class BM25EmbeddingRecall<T extends RetrievalHit = RetrievalHit> extends QueryRecall<T> {
    constructor(bm25: Retriever<T>, vector: Retriever<T>) {
        super();
        this.addTask({
            path: "bm25",
            run: async (request) => {
                return bm25.retrieve(request);
            },
        });
        this.addTask({
            path: "embedding",
            run: async (request) => {
                return vector.retrieve(request);
            },
        });
    }
}
```

`run` 的类型为 `(request: RetrievalQuery) => Promise<T[]>`。请求包含 `query` 和 `topK`，每条路径收到独立的请求副本。需要改写查询或调整单路结果时，在对应匿名函数内添加逻辑；增加召回路径时继续注册任务，不修改公共调度流程。同一组合的路径使用相同来源的索引：会话摘要或文档块。

### 等待全部路径并进入 Processor

Recall 捕获本次任务列表，使用 `Promise.allSettled()` 并行执行所有 `run`，等待全部结束后检查错误。任一路失败则报告错误，不调用 Processor；全部成功则按注册顺序生成 `RecallResult[]`。这不是多线程执行 SQLite，而是允许异步任务的等待时间重叠。

Processor 使用接口与实现类模型，初始化时与所需的 Recall 组合装配。接口如下，具体处理逻辑留空：

```ts
interface QueryProcessor<T extends RetrievalHit = RetrievalHit> {
    process(request: RetrievalQuery, results: RecallResult<T>[]): Promise<T[]>;
}
```

其中 `RecallResult<T>` 为 `{ path: string; hits: T[] }`。Processor 一次接收原始查询和所有路径的结果，可以识别路径名称、读取各路排名、分数、正文及来源坐标；对应实现类验证所需路径是否存在。单路正常返回 `[]` 时，仍将该路径交给 Processor。

### Eval 接入

Eval 继续通过现有异步搜索接口获得最终 `RetrievalHit[]`，不感知内部任务调度。计划增加 query 模式的参数校验与分派，并让它复用 vsearch 的密钥配置、向量构建和就绪检查；建库、结果导出和评分流程沿用现有接口。运行记录补充 Recall 路径组合、Processor 标识与相关实现哈希。query 的 CLI 接入尚未实现。

完整契约与集成边界见 [Memories.md](docs/Memories.md#query-混合检索设计待实现)。

## Project Structure

接口和实现分文件维护：`search/recall.ts` 只定义抽象基类，`bm25-embedding-recall.ts` 定义具体组合；`processor.ts` 只定义接口，`embedding-query-processor.ts` 定义透传实现。搜索数据契约与组合接口在 `search/types.ts`，运行时模式校验在 `search/modes.ts`。Embedding、扩展选项与两套 Eval 的配置和结果接口分别放在对应的 `types.ts`，调用方直接从类型文件导入。

```text
BatMem/
├── docs/                             # Design and evaluation guides
│   ├── Eval.md                       # Evaluation workflow
│   ├── Memories.md                   # Memory architecture
│   ├── Notes-LongMemEval.md          # Dataset research notes
│   ├── message-session-lifecycle.zh-CN.md
│   └── test.md                       # Test plan
├── eval/                             # Offline evaluation tools
│   ├── longmem/                      # Cross-session answer evaluation
│   │   ├── test/                     # Offline evaluation tests
│   │   ├── dataset.ts                # Dataset contract
│   │   ├── types.ts                  # Build, session, run and judge contracts
│   │   ├── judge-prompts.json        # Official judge templates
│   │   ├── judge.ts                  # Answer scoring
│   │   ├── longmemeval.ts            # LongMemEval adapter
│   │   ├── pi.ts                     # Pi SDK answer sessions
│   │   ├── runner.ts                 # Build and run lifecycle
│   │   ├── run.ts                    # Stage CLI
│   │   ├── runlongmem.ps1            # Windows workflow
│   │   └── sessions.ts               # History-to-Session conversion
│   └── rag/                          # Retrieval evaluation
│       ├── test/                     # Offline evaluation tests
│       ├── beir.ts                   # BEIR dataset adapter
│       ├── build.ts                  # Reusable corpus index
│       ├── dataset.ts                # Dataset contract
│       ├── types.ts                  # Build and retrieval evaluation contracts
│       ├── progress.ts               # CLI progress display
│       ├── run.ts                    # Retrieval CLI
│       ├── runbeir.ps1               # Windows workflow
│       ├── runner.ts                 # Retrieval and result export
│       ├── score_rag.py              # Ragas and ranking metrics
│       └── requirements.txt          # Python dependencies
├── src/                              # Pi extension implementation
│   ├── embedding/                    # Text encoding and vector storage
│   │   ├── jina.ts                   # Jina HTTP provider
│   │   ├── provider.ts               # Provider contract
│   │   ├── types.ts                  # Provider options and vector index records
│   │   └── vector-index.ts           # SQLite vector index
│   ├── memory/                       # Session memory
│   │   ├── service.ts                # Session sync and recall
│   │   ├── summary.ts                # Summary model adapter
│   │   └── types.ts                  # Session data contracts
│   ├── rag/                          # Markdown document indexing
│   │   ├── chunker.ts                # Source-aware chunking
│   │   ├── service.ts                # Document scan and index
│   │   └── types.ts                  # Document data contracts
│   ├── search/                       # Shared retrieval strategies
│   │   ├── bm25.ts                   # FTS5 keyword retrieval
│   │   ├── rows.ts                   # SQL result mapping
│   │   ├── recall.ts                 # Abstract recall scheduler
│   │   ├── bm25-embedding-recall.ts   # Default recall implementation
│   │   ├── processor.ts              # Processor contract
│   │   ├── embedding-query-processor.ts # Embedding passthrough implementation
│   │   ├── modes.ts                  # Runtime mode validation
│   │   ├── service.ts                # Search mode interface
│   │   ├── types.ts                  # Retrieval contracts
│   │   └── vector.ts                 # Vector query retrieval
│   ├── storage/
│   │   └── db.ts                     # SQLite schema and connection
│   ├── config.ts                     # Embedding configuration
│   ├── types.ts                      # Extension composition options
│   └── index.ts                      # Extension entry point
├── test/                             # Core offline tests
│   ├── CONTRACT.md                   # Test contract
│   ├── chunker.test.ts
│   ├── embedding.test.ts
│   ├── memory.test.ts
│   ├── rag.test.ts
│   ├── search.test.ts
│   ├── query.test.ts
│   ├── extension.test.ts
│   └── vector.test.ts
├── .env.example                      # Embedding settings template
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```
