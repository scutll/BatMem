# DocsRAG & Cross-Session Memory

## 总体架构

BatMem 通过 Pi Extension 提供两类项目内记忆：Cross-session Memory 保存会话消息和摘要，Document RAG 将本地 Markdown 切块并索引。两者共用项目目录下的 `.pi/docs-memory/index.db`，分别以会话摘要和文档块作为检索单元，结果携带原始文件的定位信息。

```text
src/index.ts：生命周期与工具入口
  ├─ SessionManager.getEntries()
  │    → MemoryService.syncSession() → 消息入库 → 增量摘要 → 摘要索引
  ├─ documents/*.md（递归）
  │    → RAGService.scanDocuments() → chunkMarkdown() → 文档块索引
  └─ SearchService.retrieve(request, options)（限定来源）
       ├─ search  → BM25Retriever → SQLite FTS5
       ├─ vsearch → VectorRetriever → 查询编码 → VectorIndex → sqlite-vec
       └─ query   → 双路召回 → RRF 融合 → Jina 重排 → 混合评分

摘要 / 文档块 → VectorIndex.syncEmbeddings() → Jina 编码 → 向量存储
```

`src/memory` 负责会话同步与摘要，`src/rag` 负责文档解析与索引，`src/search` 负责检索编排，`src/embedding` 和 `src/reranking` 对接模型服务，`src/storage/db.ts` 管理数据库结构。原始 Session JSONL 和 Markdown 文件保留为来源。

## Cross-session Memory

### 数据来源与存储

`agent_end` 从 `ctx.sessionManager` 获取会话 ID、Session 路径、项目目录和全部条目 `getEntries()`，组成 `SessionSnapshot`。同步按条目顺序处理，包含同一 Session 文件中的分支消息。

`MemoryService.extractMessages()` 提取 `user`、`assistant`、`toolResult` 消息中的文本，并将工具调用名称与参数序列化为文本。数据库以 `sessionId + entryId` 标识消息，已有消息跳过写入；图片和思考块省略。每个会话保存一份当前摘要，`leafEntryId` 记录摘要已处理到的最后一条消息。

### 记忆构建与更新

```text
agent_end → 捕获 SessionSnapshot → 加入 pendingSummary 队列
  → MemoryService.syncSession()
      → extractMessages() → saveSessionMessages()：事务保存会话与消息
      → getSessionSummary() → selectNewMessages()：选取游标后的消息
      → buildSummaryInput() → generateSessionSummary()：生成新摘要
      → saveSessionSummary()：同时保存正文、游标和更新时间
      → FTS5 触发器更新 → syncEmbeddings("memory")（配置 embedding 时）
```

首次摘要输入全部提取消息；后续输入为旧摘要与新增消息。例如，旧摘要覆盖 `m1…m3`，新增 `m4、m5` 后，模型读取“旧摘要 + m4、m5”，成功后游标推进到 `m5`。没有新增消息时跳过摘要生成，继续补建缺失向量；已保存的游标在输入中缺失时抛出错误。

`generateSessionSummary()` 通过 `ctx.modelRegistry.complete()` 使用当前聊天模型和宿主认证，保留目标、事实、决策及原因、进度、结论和未完成事项，以对话语言输出摘要，设置 `cacheRetention: "none"`。

消息先提交，模型调用期间释放写事务。摘要生成失败、返回空文本或被截断时，保留已存消息、旧摘要及旧游标。摘要保存成功后，向量生成失败会留下待补建记录。`MemoryService` 创建时通过 `ready` 启动已有摘要的向量补建，后续同步可再次补齐失败部分。

### 记忆访问

`memory_search` 检索会话摘要，返回摘要文本、分数、Session ID、来源路径、摘要游标与更新时间。Agent 可据此调用 `memory_read(sessionId, keyword)` 读取消息原文。

`memory_read` 通过 `MemoryService.readMessages()` 使用 SQLite `instr()` 做区分大小写的字面子串匹配，返回该会话最新三条匹配的 User/Assistant 消息，按时间、入库顺序倒序排列。空关键词返回空数组。工具结果参与摘要生成，原文读取结果仅包含用户和助手消息。

### Agent 集成

`before_agent_start` 每轮先清空候选，再对 `messageType === "user"` 的输入检索一个摘要，查询为 `event.prompt`。策略由扩展当前选择决定，初始值取 `retrieval.defaultStrategy`，默认 `search`；当前会话参与检索，直接选取排名第一的结果。

`context` 将候选 JSON 作为参考数据追加到本次模型请求的 User 消息中。同一轮的多次模型调用复用该候选，下一轮重新检索。追加内容仅存在于请求上下文中，不写入 Session。

## Document RAG

### 文档来源与解析

普通模式在 `session_start` 创建 `.pi/docs-memory/documents` 并启动异步扫描。`RAGService.scanDocuments()` 递归收集普通 Markdown 文件，按路径排序，读取 UTF-8 文本；扩展名比较忽略大小写，跳过符号链接。

每次扫描计算正文 SHA-256，内容相同则复用索引；修改时保留 Document ID 并替换全部块。文件变化在后续扫描时更新。

### 文档切块

`chunkMarkdown()` 按 JavaScript 字符串位置切片，每块最多 500 个 UTF-16 编码单元，相邻块重叠 100，步长 400，保留原文与换行。每块记录从 0 开始的 `chunkIndex`、从 1 开始且包含首尾的行号，以及块起点处有效的 ATX 标题（`#` 至 `######`，跳过围栏代码中的标题）。空文本返回空数组。

### 文档索引与访问

```text
scanDocuments() → indexDocument() → 内容哈希比较
  → chunkMarkdown() → replaceDocumentIndex()：逐文件事务替换文档与块
  → 全部文件处理成功 → removeDeletedDocuments()：清理扫描目录内缺失文件
  → Extension 调用 syncEmbeddings("document")（配置 embedding 时）
```

替换或删除通过触发器清理旧全文索引和向量。扫描失败时保留已提交的文件更新，并跳过删除清理；向量生成失败时，已保存文本和全文索引继续可用。

`rag_search` 等待启动扫描结束，将 Options 传给 `RAGService.searchChunks(request, options)`，由注入的 `RetrievalService` 执行检索。结果包含文档块、分数、Document ID、路径、块序号、行号和章节。同一文档可命中多个块，Agent 使用宿主 `read` 工具按路径和行号读取更多上下文。

## 存储与 Jina HTTP 服务

### 存储层

`openDatabase()` 使用 `node:sqlite`，启用外键、WAL 和 5 秒锁等待。

| 数据 | 用途 |
| --- | --- |
| `sessions`、`messages`、`summaries` | 会话来源、消息文本、当前摘要与游标 |
| `documents`、`chunks` | 文件身份、内容哈希、文档块与来源坐标 |
| `summaries_fts`、`chunks_fts` | 由触发器维护的 FTS5 全文索引 |
| `retrieval_units` 视图 | 统一摘要与文档块的正文、身份和来源字段 |
| `embeddings`、`embedding_config` | Float32 向量及统一的编码配置身份、维度 |

向量以来源类型和内容行的 rowid 关联检索单元。正文更新或删除会清除对应向量，后续同步补建。

### Jina 配置与传输

`src/config.ts` 为 embedding 和 reranker 读取 BatMem 根目录的 `.env`，文件值优先进程环境变量，包括空值。`JINA_API_KEY` 为空时工厂返回 `undefined`。代理依次取本地 `HTTPS_PROXY`、本地 `HTTP_PROXY`、进程 `HTTPS_PROXY`、进程 `HTTP_PROXY`；未配置代理时使用独立 undici 连接直连。

两类请求每次尝试超时 10 秒，覆盖响应正文读取。网络错误、超时及 HTTP 408、429、5xx 最多重试三次，429 重试前等待 20 秒。其他 HTTP 错误、无效 JSON 和响应校验失败直接抛出。

### Embedding 生成与更新

`EmbeddingProvider` 提供 `identity`、`dimensions`、`embedDocuments()` 和 `embedQuery()`。默认 Jina 实现通过 `POST /v1/embeddings` 调用 `jina-embeddings-v3`，默认 1024 维：摘要和文档块使用 `retrieval.passage`，查询使用 `retrieval.query`，启用归一化，关闭截断与 late chunking。

`VectorIndex.syncEmbeddings(source)` 在实例内串行补建缺失向量，默认每批 32 个。HTTP 等待期间释放写事务；写入前重新检查编码配置、来源身份与正文，跳过已过期的结果。失败保留已完成批次，下次同步继续补齐。Provider 与存储层校验向量数量、维度和有限数值，存储层还要求向量为非零 Float32。

数据库使用一份编码配置。配置不兼容时抛出错误；显式调用 `rebuild()` 清空全部向量并登记当前配置，再通过同步重建。`getStatus(source)` 返回总数、已索引数与待补建数。

### Reranker 接口

`RerankingProvider.rerank(query, hits, topK)` 返回 `{ index, score }[]`，`index` 对应输入候选数组的位置。默认 `JinaRerankingProvider` 将候选的 `hit.text` 按原顺序一次发送到 `POST /v1/rerank`，使用 `jina-reranker-v3`，请求 `top_n = min(topK, hits.length)` 和 `return_documents: false`。

响应校验结果数量、索引范围与唯一性、分数有限性，并按模型分数降序返回。索引用于找回原候选及其来源信息，模型分数仅用于本次排序。

## 检索编排与混合评分

### 公共接口与模式

`RetrievalService` 定义统一的 `retrieve(request, options)`，`SearchService` 实现该接口，接收 `{ query, topK }` 和上层选择的 `RetrievalOptions`，异步返回 `RetrievalHit[]`。统一字段为 `text`、`score`、`sourceType`、`sourceId` 和 `location`；摘要携带消息游标与更新时间，文档块携带块序号、行号和章节。会话与文档分别检索，各模式均按高分优先。

| 模式 | 执行路径 | 分数 |
| --- | --- | --- |
| `search` | `BM25Retriever.retrieve()` → FTS5 | `-bm25()` |
| `vsearch` | `VectorRetriever.retrieve()` → 查询编码 → `VectorIndex.search()` | `1 - cosineDistance` |
| `query` | `QueryRecall.recall()` → `EmbeddingQueryProcessor.process()` | 融合排名与重排分数的加权和 |

BM25 提取字母、数字、下划线组成的词项，逐项加引号，用 OR 连接后执行 FTS5 MATCH，使用 SQLite 默认分词器。向量检索使用原始查询编码，在编码前后检查来源索引完整性与配置，再通过 sqlite-vec 精确扫描该来源的向量。

### Options 装配与选择

`src/search/strategies.ts` 声明内置 Options：`search` 使用单路 BM25，`vsearch` 使用单路向量，两者配置 `PassthroughProcessor`；`query` 使用双路召回和融合重排。`RetrievalOptions` 包含 ID、依赖需求、可选评测描述和两个工厂，接口位于 `search/types.ts`。

Extension 在注册时合并内置策略与 `retrieval.strategies`，在 `session_start` 通过 `createSearchService()` 创建来源限定的服务。每次调用开始时按“工具 strategy 参数 → 当前策略 → 启动默认策略”选择 Options，传给服务；`/memory-strategy <名称>` 切换后续自动召回和工具检索，省略名称时查看当前选择。切换复用服务、索引和 Provider，进行中的调用继续使用原来的执行对象。

RAG Eval 的 CLI 在 `eval/rag/run.ts` 选择 Options，LongMemEval 在 `eval/longmem/run.ts` 选择，再经评测会话入口传入 Extension。程序调用可传递自定义 Options。Eval 根据 `requiresEmbedding` 判断向量构建需求，从 ID 和 metadata 保存策略描述。

### 多路召回

默认 `query` 由 `BM25EmbeddingRecall` 和 `EmbeddingQueryProcessor` 组成：

```text
SearchService.retrieve(request, HYBRID_OPTIONS)
  → BM25EmbeddingRecall.recall(request)
      ├─ bm25：BM25Retriever.retrieve(request副本)
      └─ embedding：VectorRetriever.retrieve(request副本)
      → Promise.allSettled() → 按注册顺序返回 RecallResult[]
  → EmbeddingQueryProcessor.process(原始请求, 召回结果)
      → 去重与 RRF 融合 → 排名奖励 → 截取候选
      → reranker.rerank() → 混合评分 → 排序 → topK
```

两路各自最多召回 `request.topK` 项。`ParallelRecall` 为每路提供独立请求副本，等待所有任务结束；任一路失败时抛出 `AggregateError`。`QueryRecall` 是召回接口，`ParallelRecall` 接收 `{ path, run }[]`；路径可在 `run()` 中扩写查询或处理结果。`RetrievalOptions.createRecall` 和 `createProcessor` 每次创建执行对象，Processor 接收原始请求。

### RRF 去重与融合

RRF（Reciprocal Rank Fusion，倒数排名融合）根据候选在各路中的排名累加贡献。会话摘要以 `sourceType + sourceId` 去重，文档块再加 `chunkIndex`。同一路保留首次出现的身份，去重后从 1 开始计排名；跨路命中同一身份时累加贡献，保留首次遇到的正文与来源字段。

```text
融合分 = Σ 1 / (rrfK + 路内排名) + 排名奖励
```

`rrfK` 默认 60，各路权重为 1。按各路最好排名加一次奖励：第 1 名加 0.05，第 2～3 名加 0.02，其余加 0。按融合分降序排列，同分保留首次遇到的顺序，再取前 `max(40, request.topK)` 项作为重排候选。实际候选数受召回结果限制，例如 `topK=5` 时双路最多提供 10 个候选。

### 重排索引与最终评分

Processor 将融合排序后的全部候选交给 reranker，使用原始查询获取模型分数。返回的 `index` 对应候选数组下标，因此其融合排名为 `r = index + 1`。最终评分为：

```text
finalScore = alpha(r) / r + (1 - alpha(r)) * rerankScore
alpha(r)：第 1～3 名为 0.75，第 4～10 名为 0.60，其后为 0.40
```

例如候选的融合排名为 3，模型分数为 0.8，则最终分为 `0.75 / 3 + 0.25 × 0.8 = 0.45`。融合分确定候选顺序，最终公式使用该顺序的排名倒数。Processor 替换输出 hit 的 `score`，按最终分降序取 topK，保留来源信息。

缺少 embedding、编码配置不兼容、向量索引不完整或模型请求失败时，相关检索抛出错误；非空候选缺少 reranker 时，`query` 抛出配置错误。

## Extension 生命周期与工具

| 入口 | 行为 |
| --- | --- |
| `session_start` | 等待旧扫描与同步任务，关闭旧自有 embedding、reranker 连接和数据库；打开项目数据库，创建服务，启动摘要向量补建、文档扫描及向量同步 |
| `before_agent_start` / `context` | 检索一个摘要，并临时注入本轮模型请求 |
| `agent_end` | 通过 `pendingSummary` 串行同步会话，等待摘要与向量处理结束 |
| `memory_search` | 等待 `pendingSummary`，按调用开始时选择的 Options 检索摘要 |
| `memory_read` | 按 Session ID 与关键词读取最新三条匹配消息 |
| `rag_search` | 等待扫描任务，按调用开始时选择的 Options 检索文档块 |
| `session_shutdown` | 等待扫描与同步结束，关闭自有 embedding、reranker 连接及数据库，清空服务和候选 |

两个搜索工具的 `topK` 默认 5，允许 1～100。扩展的 `retrieval.defaultStrategy` 默认 `search`。`embedding`、`reranking` 未指定时由扩展读取配置并管理连接，传入 provider 时由调用方管理，传入 `null` 时停用默认配置读取。Processor 接收上层提供的 reranker。

`evalMode` 读取已有记忆索引，跳过摘要向量补建、文档扫描和会话同步；自动检索与 `memory_search` 固定使用初始化时选定的 Options。后台扫描、摘要同步和向量构建错误通过 UI 通知，底层检索错误向调用方传播。
