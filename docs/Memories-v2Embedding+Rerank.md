# DocsRAG & Cross-Session Memory

## 总体架构

BatMem 通过 Pi Extension 提供两类项目内记忆：

- **Cross-session Memory**：保存会话消息的文本投影和当前摘要，用于检索历史信息与延续任务。
- **Document RAG**：将本地 Markdown 切块并建立索引，供 Agent 检索参考资料。

两类数据共用项目下的 `.pi/docs-memory/index.db`，分别检索会话摘要和文档块。原始 Session JSONL 与 Markdown 文件保留为来源。会话数据由 Pi 的 `SessionManager` 提供；跨会话搜索覆盖该数据库中已同步的会话。

```text
Pi 生命周期 / Agent 工具                       src/index.ts
  ├─ SessionSnapshot → MemoryService            src/memory/service.ts
  │                    └─ 摘要模型              src/memory/summary.ts
  ├─ Markdown → RAGService → Chunker            src/rag/service.ts、src/rag/chunker.ts
  └─ SearchService                             src/search/service.ts
       ├─ search → BM25Retriever → SQLite FTS5
       ├─ vsearch → VectorRetriever → VectorIndex → sqlite-vec
       └─ query → BM25EmbeddingRecall → EmbeddingQueryProcessor
                    ├─ BM25 与向量并发召回
                    └─ RRF 融合 → Jina rerank → 混合评分 → topK
```

## Cross-session Memory

### 数据来源与存储

`agent_end` 从 `ctx.sessionManager` 获取会话 ID、来源路径、项目目录和全部条目 `getEntries()`，组成 `SessionSnapshot`。

`MemoryService.extractMessages()` 提取 `user`、`assistant`、`toolResult` 消息，保存文本块，并将工具调用的名称与参数序列化为文本。图片、思考块和其他非消息记录不进入消息索引。数据库保存：

- `sessions`：会话 ID、Session 文件路径和项目目录。
- `messages`：以 `sessionId + entryId` 标识的消息文本、角色和时间。
- `summaries`：每个会话一份当前摘要，以及处理游标 `leafEntryId` 和摘要更新时间。

同步按传入条目顺序处理，不按活动分支筛选。同一会话文件中的分支消息也会进入消息索引和摘要输入。

### 记忆构建与更新

```text
agent_end → 捕获 SessionSnapshot → 排队等待前次同步
  → MemoryService.syncSession()
      → 提取消息 → 事务保存原文
      → 读取旧摘要 → 选择游标之后的新消息
      → 旧摘要与新消息 → generateSessionSummary()
      → 保存摘要和游标 → FTS5 触发器更新
      → syncEmbeddings("memory")（已配置 embedding 时）
```

原文先在事务中保存，已有消息 ID 跳过写入。首次摘要使用全部提取消息；增量摘要使用旧摘要和游标之后的新消息。例如，摘要已覆盖 `m1…m3`，新增 `m4、m5` 后，模型输入为“旧摘要 + m4、m5”，成功后游标推进至 `m5`。没有新消息时跳过摘要生成，仍补建缺失向量；已保存的游标不在输入消息中时，同步报错。

`MemoryService` 创建时启动已有摘要的向量补建，通过 `ready` 暴露完成状态。向量搜索和 query 等待启动补建结束；同步任务在启动补建失败后仍可再次尝试补齐向量。

`generateSessionSummary()` 通过 `ctx.modelRegistry.complete()` 使用当前聊天模型和宿主认证，要求保留目标、事实、决策及原因、进度、结论和未完成事项。摘要使用对话语言，输出由文本块组成，模型请求设置 `cacheRetention: "none"`。

摘要正文和游标在生成成功后一起保存。失败、空文本或截断响应保留已提交的原文、旧摘要和旧游标。摘要更新清除旧向量，再由向量同步补建。

### 记忆访问

`memory_search` 检索 `summaries`，支持 `search`、`vsearch` 和 `query`，返回摘要及来源信息。结果中的 `entryId` 是摘要处理游标，`timestamp` 是摘要更新时间。

`memory_read(sessionId, keyword)` 调用 `readMessages()`，以 SQLite `instr()` 执行区分大小写的字面子串匹配，返回指定会话中最新三条匹配的 User/Assistant 消息。结果按消息时间、入库顺序倒序排列，包含消息 Entry ID、时间和来源路径。空关键词返回空数组。工具结果参与摘要输入，不包含在原文读取结果中。
  
### Agent 集成

Agent 主动调用 `memory_search` 获取摘要，再按会话 ID 和关键词调用 `memory_read` 读取原文。

自动检索在 `before_agent_start` 执行。每次先清空候选，仅对 `messageType === "user"` 的输入搜索摘要，查询为 `event.prompt`，`topK` 为 1。检索模式由扩展选项 `memorySearchMode` 决定，默认 `search`。当前会话参与检索，结果没有额外相关性阈值。

每次 `context` 事件在请求消息副本末尾追加一条 User 消息，包含候选 JSON，并标明其为参考数据。同一轮 Agent 运行中的模型调用复用候选，下一轮重新检索；注入内容不写入 Session。

## Document RAG

### 文档来源与解析

普通运行模式的 `session_start` 创建项目下的 `.pi/docs-memory/documents` 并启动异步扫描。`RAGService.scanDocuments()` 递归收集扩展名为 `.md` 的普通文件，按路径排序并读取 UTF-8 文本；扩展名比较不区分大小写，不跟随符号链接。

文档记录包含 Document ID、来源路径、文本 SHA-256 和文件修改时间。每次扫描计算内容哈希；正文不变时复用索引，修改时保留 Document ID。扩展在会话启动时扫描，运行中的文件变化在后续扫描时进入索引。

### 文档切块

`chunkMarkdown()` 按 JavaScript 字符串位置切片：每块最多 500 个 UTF-16 编码单元，相邻块重叠 100，步长 400。切片保留原文和换行序列，空文本返回空数组，不生成只有重叠内容的尾块。

每块保存从 0 开始的 `chunkIndex`、从 1 开始且包含首尾的行号，以及块起点处有效的 ATX 标题，即 `#` 到 `######` 标题。标题识别跳过围栏代码块。`Document ID + chunkIndex` 共同定位块。

### 文档索引与访问

```text
scanDocuments() → indexDocument() → 内容哈希比较
  → chunkMarkdown() → replaceDocumentIndex()
      → 事务替换文档记录和全部块 → FTS5 触发器更新
  → 全部文件处理成功后，清理扫描目录内已删除的文档
  → Extension 调用 syncEmbeddings("document")（已配置 embedding 时）
```

新增和修改按文件分别提交。修改删除旧块及其向量，再写入当前块；删除文档通过级联和触发器清理块、全文索引和向量。扫描失败时保留已经提交的文件更新，跳过删除清理。`replaceDocumentIndex()` 也接收准备好的块，直接事务写入文档和块记录。

BM25 和向量检索使用同一批块。文本入库完成后生成缺失向量；embedding 失败时，已保存的文本和 FTS5 索引继续可用。

`rag_search` 等待启动扫描结束，通过限定 `document` 来源的 `SearchService` 返回 topK 块，支持三种检索模式。每项包含文本、分数、Document ID、来源路径、块序号、行号和章节。同一文档可有多个块命中。Agent 使用宿主 `read` 工具按路径和行号读取更多上下文。

## 存储与 Jina HTTP 服务

### 存储层

`openDatabase()` 使用 `node:sqlite`，启用外键、WAL 和 5 秒锁等待。触发器维护 `summaries_fts` 与 `chunks_fts`；`retrieval_units` 视图统一摘要和文档块的正文、身份与来源坐标。

向量以 Float32 BLOB 存入 `embeddings`，由来源类型和内容行的 rowid 关联检索单元。`embedding_config` 保存编码配置身份和维度。sqlite-vec 在向量操作初始化时加载。数据库连接由创建方管理，服务通过传入连接访问数据。

### Jina 配置与传输

`src/config.ts` 中的 `createEmbeddingProvider()` 和 `createRerankingProvider()` 共用配置读取逻辑。BatMem 根目录 `.env` 的值优先进程环境变量，包括空值；读取配置不修改宿主环境。

- `JINA_API_KEY` 提供 Bearer 认证，空值使工厂返回 `undefined`。
- 代理按本地 `HTTPS_PROXY`、本地 `HTTP_PROXY`、进程 `HTTPS_PROXY`、进程 `HTTP_PROXY` 的顺序选择。
- 两个 Jina 实现均使用独立的 undici Agent 或 ProxyAgent；未配置代理时显式直连。
- 构造选项中的 `fetch` 注入替代 HTTP 传输，供离线测试使用。

每次 HTTP 尝试的超时为 10 秒，覆盖响应正文读取。网络错误、超时及 HTTP 408、429、5xx 最多重试三次，总共四次尝试。429 重试前等待 20 秒，其余可重试错误立即重试。其他 HTTP 错误、无效 JSON 和成功响应的契约校验错误直接抛出。错误消息不包含 API 密钥或服务端错误正文。

两个 Jina provider 均提供 `close()` 释放自有 HTTP 连接。Extension 关闭自身创建的 embedding provider；Processor 创建的 reranker 不在扩展关闭流程中。

### Embedding 生成与更新

`EmbeddingProvider` 接口位于 `src/embedding/provider.ts`，定义 `identity`、`dimensions`、`embedDocuments()` 和 `embedQuery()`。文档向量按输入顺序返回；批次失败时整个请求报错。

| 项目 | 配置 |
| --- | --- |
| HTTP 接口 | `POST https://api.jina.ai/v1/embeddings` |
| 模型 | `jina-embeddings-v3` |
| 维度 | 默认 1024，构造选项允许 1～1024 |
| 摘要、文档块编码 | `retrieval.passage` |
| 查询编码 | `retrieval.query` |
| 编码参数 | `embedding_type: "float"`、`normalized: true`、`truncate: false`、`late_chunking: false` |
| 索引批次 | 默认每批 32 个检索单元 |

`JinaEmbeddingProvider` 校验响应数量、唯一索引、向量维度和有限数值，按响应 `index` 还原输入顺序。`VectorIndex` 在存储边界继续校验数量、维度、Float32 有限性及非零向量。

`VectorIndex.syncEmbeddings(source)` 在实例内串行补建指定来源的缺失向量。每次同步以开始时的最大检索单元 ID 界定范围；等待 HTTP 时不持有写事务，写入前检查编码配置、来源身份和正文，跳过过期结果。

正文更新或删除清除旧向量。批次失败保留已完成数据，下一次同步补齐缺失部分。模型、维度或编码配置不兼容时抛出错误；`rebuild()` 清空全部向量并登记当前配置，后续同步重建向量。`getStatus(source)` 返回 `{ total, indexed, pending }`。

### Reranker 接口

`RerankingProvider` 抽象类位于 `src/reranking/provider.ts`，Jina 实现位于 `src/reranking/jina.ts`，配置与结果类型位于 `src/reranking/types.ts`。

```ts
rerank(query: string, hits: readonly RetrievalHit[], topK: number): Promise<RerankResult[]>

interface RerankResult {
    index: number;
    score: number;
}
```

文本转换方法 `toDocuments()` 实现位于抽象基类，作为受保护方法供子类调用。它按原顺序提取 `hit.text`，保留重复文本和空文本，使返回索引与输入位置一一对应。`JinaRerankingProvider.rerank()` 调用该方法后，一次发送整个候选集合。

| 项目 | 配置 |
| --- | --- |
| HTTP 接口 | `POST https://api.jina.ai/v1/rerank` |
| 模型 | `jina-reranker-v3` |
| 输入 | 原始查询 `query`、候选文本数组 `documents` |
| 返回数量 | `top_n: min(topK, hits.length)` |
| 返回正文 | `return_documents: false` |
| 结果映射 | `relevance_score` 映射为 `score`，`index` 保持为输入候选下标 |

空候选或无效 topK 返回空数组；有效请求中的空白查询报错。成功响应校验数量、索引范围、索引唯一性和有限分数，结果按模型分数降序返回。模型分数不作为跨请求可比的概率。

## 检索编排与混合评分

### 公共接口与模式

`SearchService` 接收 `{ query, topK }`，异步返回有序的 `RetrievalHit[]`。MemoryService 组合摘要检索器，Extension 为文档创建限定 `document` 来源的检索器。

| 模式 | 执行链路 | 返回分数 |
| --- | --- | --- |
| `search` | `BM25Retriever.retrieve()` | SQLite 原生 `bm25()` 取负 |
| `vsearch` | 查询编码 → `VectorIndex.search()` | `1 - cosineDistance` |
| `query` | BM25 与向量召回 → RRF 与排名奖励 → Jina rerank → 混合评分 | RRF 排名倒数与模型分数的加权和 |

BM25 提取字母、数字、下划线组成的词项，逐项用引号包裹，再用 OR 连接执行 FTS5 MATCH。FTS5 使用默认分词器，中文没有专门分词处理。

向量检索在查询编码前检查配置和该来源的向量完整性，使用原始查询编码，编码后再次检查，再由 sqlite-vec 精确扫描指定来源的向量。缺少 provider、配置不兼容、索引不完整或编码失败均抛出错误。

`rowToHit()` 统一返回 `text`、`score`、`sourceType`、`sourceId` 和 `location`。摘要的 location 包含来源路径、游标 Entry ID 和摘要更新时间；文档块包含来源路径、块序号、行号及章节。所有模式均按高分优先，BM25 与向量原始分数不直接相加。

### 多路召回

默认 query 组合为 `BM25EmbeddingRecall` 与 `EmbeddingQueryProcessor`。`SearchService` 也接收包含 `recall` 和 `processor` 的自定义 `QueryPipeline`。

```text
SearchService.query({ query, topK })
  → BM25EmbeddingRecall.recall(request)
      ├─ path=bm25      → BM25Retriever.retrieve(请求副本)
      └─ path=embedding → VectorRetriever.retrieve(请求副本)
      → Promise.allSettled() 等待全部路径
      → RecallResult[]：每项包含 path 和有序 hits
  → EmbeddingQueryProcessor.process(原始请求, 全部结果)
  → RetrievalHit[]
```

`QueryRecall` 抽象类通过 `addTask({ path, run })` 注册任务。路径名必须非空且唯一；每路接收独立请求副本，可执行查询改写和路径内处理。所有路径完成后，结果按注册顺序汇总。空数组作为成功结果保留；任一路失败时，等待其他路径结束后抛出包含路径与原始原因的 `AggregateError`，不调用 Processor。

默认两路分别使用请求的 topK 作为召回上限。同一次组合限定同一来源，memory 与 document 分别执行双路召回。HTTP 等待期间不持有数据库写事务，多路读取不保证处于同一数据库快照。

### RRF 去重与融合

RRF（Reciprocal Rank Fusion）按结果排名计算每路贡献。`EmbeddingQueryProcessor` 使用以下身份判断重复：

- 会话摘要：`sourceType + sourceId`。
- 文档块：`sourceType + sourceId + location.chunkIndex`。

同一路先保留每个身份首次出现的 hit，按去重后的顺序从 1 开始计排名。同一路重复记录不贡献额外分数，也不占用后续排名。不同来源或不同文档块即使正文相同，也保留为不同候选。

```text
单路贡献 = 1 / (rrfK + rank)
融合基础分 = 各召回路径贡献之和
bestRank = 各路径中该候选排名的最小值
```

`rrfK` 默认 60，构造器允许非负安全整数。各路径权重均为 1。跨路重复只保存一个候选，正文与来源字段保留首次遇到的 hit，贡献累加后按最好排名加一次奖励：

| 最好排名 bestRank | 奖励 |
| --- | --- |
| 1 | 0.05 |
| 2～3 | 0.02 |
| 4 及以后 | 0 |

候选按“融合基础分 + 奖励”降序排列，分数相同时保留首次遇到的顺序，再截取前 `max(40, request.topK)` 个进入重排。候选数量受各路实际召回数量限制；40 的候选预算不会增加底层召回数量。

### 重排索引与最终评分

Processor 按 RRF 排序后的候选顺序构建 `rerankCandidates: T[]`，调用 `reranker.rerank(request.query, rerankCandidates, rerankCandidates.length)`，获取全部候选的模型分数。无候选时返回空数组；非空候选缺少 reranker 时抛出配置错误，模型请求失败直接向调用方传播。

```text
各路 hits 的局部排名 → 计算贡献和 bestRank
  → 去重融合、加奖励、排序、截取
  → rerankCandidates：固定顺序的候选数组
  → rerank 返回 { index, score }
  → hit = rerankCandidates[index]
  → r = index + 1
  → 计算最终分数 → 重新排序 → 截取 request.topK
```

reranker 的 `index` 从 0 开始，只对应传入的 `rerankCandidates` 下标；`r` 是从 1 开始的 RRF 融合排名。模型响应在结果数组中的位置不参与排名计算，各召回路径的局部下标也不参与最终混合。

```text
finalScore = alpha(r) / r + (1 - alpha(r)) * rerankScore
```

| RRF 排名 r | alpha(r) |
| --- | --- |
| 1～3 | 0.75 |
| 4～10 | 0.60 |
| 11 及以后 | 0.40 |

例如，`rerankCandidates[2]` 的 RRF 排名为 3，即使模型将其作为响应第一项返回，仍使用 `r = 3`。模型分数为 0.8 时，最终分数为 `0.75 / 3 + 0.25 * 0.8 = 0.45`。

RRF 累加分和 bonus 决定候选顺序，最终公式使用该顺序的排名倒数。模型对全部候选评分后，Processor 复制对应 hit 并替换 `score`，按最终分降序排序，再取 topK。输入召回数组、输入 hit 的分数及来源坐标保持不变。

## Extension 生命周期与工具

| 生命周期或工具 | 调用与等待关系 |
| --- | --- |
| `session_start` | 等待旧扫描和摘要任务，关闭扩展自有 embedding 连接及旧数据库；打开项目数据库，创建服务，启动摘要向量补建、文档扫描与向量同步 |
| `before_agent_start` | 清空候选；用户输入按 memorySearchMode 搜索一个摘要 |
| `context` | 将候选临时追加到模型请求上下文 |
| `agent_end` | 按 pendingSummary 队列同步消息、生成摘要并补建向量，等待完成 |
| `memory_search` | 等待 pendingSummary，按 mode 搜索摘要；topK 默认 5，工具允许 1～100 |
| `memory_read` | 读取指定会话中最新三条匹配的 User/Assistant 消息 |
| `rag_search` | 等待 scan，按 mode 搜索文档块；topK 默认 5，工具允许 1～100 |
| `session_shutdown` | 等待扫描与摘要任务，关闭扩展自有 embedding 连接及数据库，清空服务和候选 |

扩展选项 `embedding` 接收调用方管理的 provider，`null` 明确停用，未指定时读取配置。扩展不关闭外部注入的 embedding provider。默认 query Processor 独立读取 Jina 配置创建 reranker；直接构造 Processor 时也可注入自定义 reranker。

`evalMode` 使用已有摘要和向量索引，不启动摘要向量补建、文档扫描或 agent_end 摘要同步。自动检索与 memory_search 使用固定的 memorySearchMode，工具传入的 mode 不覆盖该选项。

Extension 捕获后台扫描、摘要同步与向量构建错误并通过 UI 通知。底层检索服务返回结果或抛出错误，向量召回和重排失败不会静默降级为 BM25。
