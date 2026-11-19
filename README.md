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

### Retrieval Strategy

`memory_search` 和 `rag_search` 通过 `strategy` 选择已注册的 Options；省略时使用当前选择，初始默认为 `search`。

| strategy | 行为 |
| --- | --- |
| `search`（默认） | BM25 关键词检索，不需要 embedding 密钥 |
| `vsearch` | 向量语义检索，需要密钥及完整的向量索引 |
| `query` | BM25 与向量并发召回，经过 RRF 融合、Jina 重排和混合评分，需要完整向量索引 |
| `multi_bm25` | 原始查询与三种 AI 改写并发检索 BM25，通过 RRF 融合，需要 DeepSeek 密钥 |

例如，让 Agent 使用 `rag_search` 并指定以下参数：

```json
{ "query": "如何恢复上次任务的进度", "topK": 5, "strategy": "vsearch" }
```

使用 `/memory-strategy` 查看当前策略和可选名称，使用 `/memory-strategy query` 切换后续的自动召回及两个搜索工具。工具的 `strategy` 参数仅覆盖本次调用。设置密钥后初始策略仍为 BM25。显式 `vsearch` 遇到模型失败或索引未完成时会报错，不会偷偷降级。已完成的向量批次会保留，后续同步可以补建缺失部分。

如需停用 embedding，将 `.env` 中的密钥设置为 `JINA_API_KEY=` 后重新启动 Pi；已有文本和向量不会被删除。

### RAG Evaluation

填写 `.env` 后，从 BatMem 目录运行；将数据集路径替换为本地 BEIR 目录，输出目录必须尚不存在：

```powershell
node eval/rag/run.ts --dataset "<BEIR目录>" --output "eval/rag/runs/vector-01" --mode vsearch --top-k 10
```

BM25 对照实验使用 `--mode search` 和另一个输出目录。两种模式都导出相同格式的 `retrieval.jsonl`，供现有 Python 评分程序读取，具体评分方式见 [Eval.md](docs/Eval.md)。

双路召回使用 `--mode query`，PowerShell 使用 `-Mode query`；LongMemEval 使用 `--retrieval query` 或 `-Retrieval query`。CLI 在入口选择 Options，query 执行融合、重排与混合评分。两路均成功后才进入 Processor，任一路失败会等待全部路径结束再报错，不降级。

CLI 默认把可复用索引保存在 `eval/rag/builds/<语料指纹>/index.db`。同一语料首次完整生成文档向量，后续运行复用；中断后换一个新的输出目录重跑，会补建缺失向量。改变 Top-K 或 split 不重建语料向量，查询文本仍在每次运行时编码。可通过 `--builds` 更改缓存根目录。

准备好 Python 评分环境后，也可以一键检索、评分并显示中文指标：

```powershell
.\eval\rag\runbeir.ps1 "<BEIR目录>" -Mode vsearch -TopK 10
```

过程显示阶段提示和单行刷新进度；输出重定向到文件时改为间隔日志。每次评测结果单独保存到 `eval/rag/runs/`，不会覆盖上一轮结果。

## Options 与统一检索

Extension、RAG Eval 和 LongMemEval 共用 `RetrievalOptions`。策略在 [strategies.ts](src/search/strategies.ts) 的 `DEFAULT_STRATEGIES` 注册，上层按名称选择并传入服务：

```text
策略名称 → RetrievalOptions → createRecall → 各路径 run()
                         → createProcessor → 汇总、排序 → 截取 topK
```

`createRecall` 和 `createProcessor` 接收已绑定当前数据源的 `bm25`、可选的 `vector`、`reranker` 等依赖。服务每次检索创建 Recall 和 Processor，切换策略时复用数据库和 Provider。接口定义见 [types.ts](src/search/types.ts)、[recall.ts](src/search/recall.ts) 和 [processor.ts](src/search/processor.ts)。

### 自定义召回路径

提示词、召回路径和 Options 可集中在一个策略文件。简单组合也可以直接写在 `strategies.ts` 中。下面是在 `src/search/expanded-bm25.ts` 中新增单路策略的完整示例：

```ts
import { deepseekCompletion } from "../ai/deepseek-completion.ts";
import { ParallelRecall } from "./parallel-recall.ts";
import { PassthroughProcessor } from "./passthrough-processor.ts";
import type { RetrievalOptions } from "./types.ts";

const EXPAND_PROMPT =
    "将输入改写为文档检索查询，保留实体和限制条件，补充少量相关术语。只输出查询文本。";

export function createExpandedBM25Options(): RetrievalOptions {
    let llm: deepseekCompletion | undefined;

    return {
        id: "expanded_bm25",
        requiresEmbedding: false,
        metadata: {
            recallPaths: ["bm25_expanded"],
            processor: "passthrough",
            score: "negated SQLite BM25; descending",
        },
        createRecall: ({ bm25 }) => new ParallelRecall([
            {
                path: "bm25_expanded",
                run: async (request) => {
                    llm ??= new deepseekCompletion({ system: EXPAND_PROMPT });
                    const query = await llm.getResponse(request.query);
                    return bm25.retrieve({
                        ...request,
                        query,
                        topK: Math.max(20, request.topK),
                    });
                },
            },
        ]),
        createProcessor: () => new PassthroughProcessor(),
    };
}
```

每条路径由唯一、非空的 `path` 和异步 `run(request)` 组成。查询扩写、候选数量调整和单路结果处理直接写在 `run()` 中，返回保留来源坐标的 `RetrievalHit[]`。各路径接收独立的请求副本，Processor 接收原始查询与各路径的结果。服务最后按原始 `topK` 截取。

AI 实例在首次执行扩写时创建，后续调用复用；注册策略本身不读取密钥、不请求模型。当前 DeepSeek 适配器使用 Fetch 调用非流式接口，密钥读取 BatMem 根目录 `.env` 的 `DEEPSEEK_API_KEY`，其次读取同名环境变量：

```dotenv
DEEPSEEK_API_KEY=your-deepseek-api-key
```

模型、端点和超时可在 `new deepseekCompletion({ ... })` 中设置，配置类型见 [ai/types.ts](src/ai/types.ts)。扩写模型独立于 Pi 的对话模型配置；当前默认模型为 `deepseek-flash`。

### 多路召回与自定义 Processor

已有的 [multiBm25Recall.ts](src/search/multiBm25Recall.ts) 将提示词、延迟创建的 AI 实例、四条路径和 RRF 后处理集中在 `createMultiBM25Options()` 中：

| 路径 | 查询来源 |
| --- | --- |
| `bm25_original` | 原始查询 |
| `bm25_keyphrases` | 提取核心实体、关键词和概念 |
| `bm25_synonym` | 同义词、缩写和替代表达 |
| `bm25_document` | 接近目标文档表述的改写 |

四条路径并发执行，其中三条调用模型。全部成功后进入 Processor；任一路失败会等待其余路径结束再报错。当前每路召回数量使用请求的 `topK`；需要扩大融合候选池时，可在各路 `run()` 内单独设置数量。

该策略按结果身份去重，以 `1 / (60 + rank)` 累加各路排名贡献，再按融合分数降序返回。Memory 的身份为 Session ID，Document 的身份为文档 ID 与 Chunk Index。

增加路径时，将任务加入 `ParallelRecall` 数组，并同步更新 `metadata.recallPaths`。需要向量的组合设置 `requiresEmbedding: true`，并在 `createRecall` 中校验 `vector` 存在。

`createProcessor` 可以返回实现 `QueryProcessor` 的对象，或创建单独实现文件中的类。其方法为：

```ts
process(
    request: RetrievalQuery,
    results: RecallResult<RetrievalHit>[],
): Promise<RetrievalHit[]>;
```

单路透传使用 `PassthroughProcessor`，多路组合需提供去重、融合或重排逻辑。已有 `EmbeddingQueryProcessor` 提供 RRF、排名奖励、模型重排与混合评分，通过 `createProcessor: ({ reranker }) => new EmbeddingQueryProcessor(reranker)` 装配，并需要已配置的 Reranking Provider。纯 BM25 + RRF 组合无需 embedding 或 reranker。

### 注册到公共策略表

在 `strategies.ts` 导入策略工厂并加入 `DEFAULT_STRATEGIES`。当前 `multi_bm25` 已注册；按上述示例新增 `expanded_bm25` 时，注册表写为：

```ts
import { createExpandedBM25Options } from "./expanded-bm25.ts";
import { createMultiBM25Options } from "./multiBm25Recall.ts";

export const DEFAULT_STRATEGIES: Readonly<Record<string, RetrievalOptions>> = {
    search: BM25_RECALL,
    vsearch: EMBEDDING_RECALL,
    query: BM25_EMBEDDING_RRF_RERANK_OPTIONS,
    multi_bm25: createMultiBM25Options(),
    expanded_bm25: createExpandedBM25Options(),
};
```

注册表的键用于命令、工具和 CLI 选择，`id` 用于记录和恢复评测策略，应保持一致。`metadata` 描述实际路径、处理方式和分数含义，不参与执行。新增公共策略后，Extension 与两套 Eval CLI 都能识别；`modes.ts` 从注册表自动生成可选名称，两个 PowerShell 包装脚本也接受自定义检索名称。

### 接入 Extension

公共注册完成后，继续加载现有 `src/index.ts`，重新启动 Pi 即可选择策略：

- `/memory-strategy`：查看当前策略与可选名称。
- `/memory-strategy multi_bm25`：切换后续自动召回、`memory_search` 和 `rag_search`。
- 工具参数 `{"query":"恢复任务","topK":5,"strategy":"multi_bm25"}`：仅覆盖本次调用；省略 `strategy` 时使用当前选择。

初始策略默认为 `search`。在自己的 ExtensionFactory 中调用 BatMem 时，可通过 Options 指定初始选择：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension from "./src/index.ts";

export default function extension(pi: ExtensionAPI): void {
    registerExtension(pi, {
        retrieval: { defaultStrategy: "multi_bm25" },
    });
}
```

上述包装入口文件放在 BatMem 根目录；采用此入口时，将包的 `pi.extensions` 指向该文件，并只加载这一个 BatMem 入口。公共注册方式本身无需修改入口文件或包配置。

`retrieval.strategies` 也可以注入或覆盖当前扩展实例的策略。需要同时供 Eval CLI 使用的组合放入公共注册表。已开始的请求继续使用进入时选择的 Options；评测模式固定初始策略，工具参数和切换命令均不能改变它。

### 接入 Eval

公共策略注册后，两套 CLI 通过名称选择同一种 Options，并将实际对象传给 Runner，无需增加 Runner 分支。以下命令从 BatMem 根目录执行，数据集路径替换为本地路径，输出目录必须尚不存在。

RAG Eval 通过 `--mode` 选择：

```powershell
node eval/rag/run.ts --dataset "<BEIR目录>" --output "eval/rag/runs/multi-bm25-01" --mode multi_bm25 --top-k 10
```

准备好 Python 评分环境后，可用包装脚本完成检索与评分：

```powershell
.\eval\rag\runbeir.ps1 "<BEIR目录>" -Mode multi_bm25 -TopK 10
```

LongMemEval 通过 `--retrieval` 选择；`--mode memory` 控制是否使用记忆。下例依次完成准备、建库、回答和评分：

```powershell
node eval/longmem/run.ts --stage all --dataset "<LongMemEval JSON文件>" --output "eval/longmem/runs/multi-bm25-01" --provider "<Pi Provider>" --model "<Pi模型>" --mode memory --retrieval multi_bm25 --limit 5
```

对应的 PowerShell 入口为：

```powershell
.\eval\longmem\runlongmem.ps1 "<LongMemEval JSON文件>" -Provider "<Pi Provider>" -Model "<Pi模型>" -Retrieval multi_bm25 -Limit 5
```

LongMemEval 的 Provider 和模型需已在 Pi 配置中可用，用于摘要、回答及默认 Judge；查询扩写仍使用策略内部的 DeepSeek 配置。自动召回与后续搜索工具调用都会执行所选策略。

分阶段运行时，在 `prepare` 指定 `--retrieval multi_bm25`，后续阶段从 run 清单恢复名称，再到公共注册表选择实现。更换策略使用新的 run 目录；修改同名策略的提示词或算法后，也应新建实验并保留对应代码版本。清单记录策略 ID 与 metadata，不会保存完整的可执行策略和提示词。详细评测流程见 [Eval.md](docs/Eval.md)。

## Project Structure

接口和实现分文件维护：`search/recall.ts` 定义召回接口，`parallel-recall.ts` 实现并发调度，`bm25-embedding-recall.ts` 定义双路组合；`processor.ts` 只定义接口，`embedding-query-processor.ts` 实现融合与重排，`passthrough-processor.ts` 实现单路透传。搜索数据契约与组合接口在 `search/types.ts`，运行时模式校验在 `search/modes.ts`。Embedding、扩展选项与两套 Eval 的配置和结果接口分别放在对应的 `types.ts`，调用方直接从类型文件导入。

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
│   │   ├── recall.ts                 # Recall contract
│   │   ├── bm25-embedding-recall.ts   # Default recall implementation
│   │   ├── parallel-recall.ts         # Concurrent task execution
│   │   ├── passthrough-processor.ts   # Single-path passthrough
│   │   ├── strategies.ts              # Built-in retrieval Options
│   │   ├── create-service.ts          # Source-bound service composition
│   │   ├── processor.ts              # Processor contract
│   │   ├── embedding-query-processor.ts # RRF fusion, reranking and score blending
│   │   ├── modes.ts                  # Runtime mode validation
│   │   ├── service.ts                # Unified retrieval service
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
