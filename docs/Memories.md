# DocsRAG & Cross-Session Memory

## 总体架构

BatMem 通过 Pi Extension 提供两类项目内记忆：

- **Cross-session Memory**：保存会话消息的文本投影和当前摘要，用于检索历史信息与延续任务。
- **Document RAG**：将本地 Markdown 切块并建立索引，供 Agent 检索参考资料。

两类数据共用项目下的 `.pi/docs-memory/index.db`，分别检索摘要和文档块。原始 Session JSONL 与 Markdown 文件保留为来源。会话由 Pi 的 `SessionManager` 提供；跨会话搜索覆盖该数据库中已经同步的会话。

```text
Pi 生命周期 / Agent 工具                 src/index.ts
  ├─ SessionSnapshot → MemoryService     src/memory/service.ts
  │                    └─ 摘要模型       src/memory/summary.ts
  ├─ Markdown → RAGService → Chunker     src/rag/service.ts、src/rag/chunker.ts
  └─ SearchService                      src/search/service.ts
       ├─ BM25Retriever → SQLite FTS5
       └─ VectorRetriever → 查询编码 → VectorIndex → sqlite-vec

文本与来源坐标 → SQLite → 缺失向量编码 → embeddings
```

## Cross-session Memory

### 数据来源与存储

`agent_end` 时，Extension 从 `ctx.sessionManager` 获取会话 ID、来源路径、项目目录和全部条目 `getEntries()`，组成 `SessionSnapshot`。

`MemoryService.extractMessages()` 提取 `user`、`assistant`、`toolResult` 消息，保存文本块，并将工具调用的名称与参数序列化为文本。图片、思考块和其他非消息记录不进入消息索引。数据库保存：

- `sessions`：会话 ID、Session 文件路径和项目目录。
- `messages`：以 `sessionId + entryId` 标识的消息文本、角色和时间。
- `summaries`：每个会话一份当前摘要，以及处理游标 `leafEntryId` 和摘要更新时间。

同步按条目顺序处理；同一会话文件中的分支消息也会进入索引和摘要。

### 记忆构建与更新

```text
agent_end → 捕获 SessionSnapshot → 排队等待前次同步
  → syncSession()
      → extractMessages() → saveSessionMessages()
      → 读取旧摘要 → selectNewMessages()
      → buildSummaryInput() → generateSessionSummary()
      → saveSessionSummary() → FTS5 触发器更新
      → syncEmbeddings("memory")（已配置 embedding 时）
```

原文先在事务中保存，已有消息 ID 跳过写入。首次摘要使用全部提取消息；后续使用旧摘要和游标之后的新消息。例如，摘要已覆盖 `m1…m3`，新增 `m4、m5` 后，模型输入为“旧摘要 + m4、m5”，成功后游标推进至 `m5`。没有新消息时跳过摘要生成，仍可补建向量；游标缺失时同步报错。`MemoryService` 创建时还会检查并补建已有摘要的向量，`index.ts` 只等待服务的 `ready` 状态。

`generateSessionSummary()` 通过 `ctx.modelRegistry.complete()` 使用当前聊天模型和宿主认证，要求保留目标、事实、决策及原因、进度、结论和未完成事项。

摘要正文和游标在生成成功后一起保存。失败、空文本或截断响应会保留原文、旧摘要和旧游标，下一次同步继续处理未总结的消息。摘要更新使旧向量失效，随后补建。

### 记忆检索

记忆访问分为摘要召回与原文读取：

- **摘要召回**：`memory_search` 检索 `summaries`，支持 BM25 和向量搜索，返回摘要及来源信息。
- **原文读取**：`memory_read(sessionId, keyword)` 调用 `readMessages()`，以 `instr()` 做区分大小写的字面子串匹配，返回指定会话中最新三条匹配 User/Assistant 消息。结果按时间、入库顺序倒序排列；空关键词返回空数组。

工具结果参与摘要输入。摘要结果中的 `entryId` 是处理游标，`timestamp` 是摘要更新时间；原文读取返回匹配消息的 Entry ID、消息时间和来源路径。

### Agent 集成

主动检索由 Agent 调用 `memory_search`，再根据会话 ID 和关键词调用 `memory_read`。

自动检索在 `before_agent_start` 执行：每次先清空候选，仅对 `messageType === "user"` 的输入调用 `MemoryService.searchSummaries({ query: event.prompt, topK: 1 })`，默认使用 BM25。有匹配时保存排名第一的摘要；当前会话也参与检索，候选没有额外相关性阈值。

随后每次 `context` 事件在请求消息副本末尾追加一条 User 消息，包含候选 JSON，并标明其为参考数据。同一轮模型调用复用候选，下一轮重新检索；注入内容不写入 Session。

## Document RAG

### 文档来源与解析

`session_start` 创建项目下的 `.pi/docs-memory/documents`，启动异步扫描。`RAGService.scanDocuments()` 递归收集本地 `.md` 文件，按路径排序并读取 UTF-8 文本。

文档记录包含 Document ID、来源路径、文本 SHA-256 和文件修改时间。每次扫描计算哈希，内容不变时复用索引，修改时保留 Document ID。扩展在会话启动时扫描，运行中的文件变化在后续扫描时进入索引。

### 文档切块

`chunkMarkdown()` 按 JavaScript 字符串位置切片：每块最多 500 个 UTF-16 编码单元，相邻块重叠 100，步长 400。切片保留原文和换行序列。

每块保存从 0 开始的 `chunkIndex`、从 1 开始且含首尾的行号，以及块起点处的有效 `#` 标题；标题识别跳过围栏代码块。`Document ID + chunkIndex` 共同定位块。

### 文档索引

```text
scanDocuments() → indexDocument() → 内容哈希比较
  → chunkMarkdown() → replaceDocumentIndex()
      → 事务替换文档记录和全部 Chunk → FTS5 触发器更新
  → 全部文件处理成功后，清理扫描目录内已删除的文档
  → syncEmbeddings("document")（已配置 embedding 时）
```

新增和修改按文件分别提交；修改会删除旧块及其向量，再写入当前块。删除文档通过级联与触发器清理块、全文索引和向量。扫描失败时，已经提交的文件更新保留，删除清理跳过。

BM25 与向量检索使用同一批 Chunk。文本入库完成后生成缺失向量，embedding 失败时已保存的文本和 FTS5 索引继续可用。

### 文档检索

`rag_search` 通过文档专用 `SearchService` 返回 Top-K 块，包含文本、分数、Document ID、来源路径、块序号、行号和章节。结果按块返回，同一文档可以有多个命中。Agent 可用宿主 `read` 工具按路径和行号读取更多上下文。

### Agent 集成

Agent 按需调用 `rag_search`，等待启动扫描结束后检索已有索引；自动上下文注入使用会话摘要。

## 公共基础设施

### 存储层

`openDatabase()` 使用 `node:sqlite`，启用外键、WAL 和 5 秒锁等待。触发器维护 `summaries_fts` 与 `chunks_fts`；`retrieval_units` 视图统一摘要和文档块的文本、身份与来源坐标。

向量以 Float32 BLOB 存入 `embeddings`，由来源类型和内容行的 rowid 关联检索单元。`embedding_config` 保存当前编码配置身份和维度。sqlite-vec 在向量操作初始化时加载。

### Embedding 生成与更新

`createEmbeddingProvider()` 读取 BatMem 根目录的 `.env` 和进程环境变量，文件值优先。`JINA_API_KEY` 为空时停用向量能力，BM25 继续可用。`HTTPS_PROXY` / `HTTP_PROXY` 配置 Jina 专用代理。

当前扩展使用以下编码配置：

| 项目 | 实现 |
| --- | --- |
| HTTP 接口 | `https://api.jina.ai/v1/embeddings` |
| 模型与维度 | `jina-embeddings-v3`，1024 维 |
| 摘要、文档块编码 | `retrieval.passage` |
| 查询编码 | `retrieval.query` |
| 输入与输出 | `truncate: false`、`late_chunking: false`、归一化浮点向量 |
| 索引批次 | 默认每批 32 个检索单元 |

`VectorIndex.syncEmbeddings(source)` 串行补建缺失向量，校验响应数量、顺序映射、维度和数值。等待 HTTP 时不持有写事务，写入前检查编码配置、来源身份及正文，跳过过期结果。

正文变化或删除时清除旧向量；失败后已完成批次保留，后续同步补齐缺失部分。模型、维度或编码选项不兼容时报告错误；服务层可调用 `rebuild()` 清空向量、登记新配置，再重新同步。

Jina 每次尝试超时 10 秒；网络错误、超时及 HTTP 408/429/5xx 最多重试三次。429 重试前等待 20 秒，其他可重试错误立即重试。其他 HTTP 错误及无效成功响应直接报错。

### 检索接口

`SearchService` 接收 `{ query, topK }`，异步返回有序的 `RetrievalHit[]`。`MemoryService` 内部组合摘要的 BM25 与向量检索；Extension 为文档创建限定 `document` 来源的服务：

```text
memory_search / rag_search
  ├─ mode=search（默认）→ SearchService.search() → BM25Retriever.retrieve()
  │    → 提取字母、数字、下划线组成的词项 → 引号包裹并用 OR 连接
  │    → FTS5 MATCH → -bm25() → 按分数降序取 Top-K
  └─ mode=vsearch → SearchService.vsearch() → VectorRetriever.retrieve()
       → 检查配置及该来源向量完整性 → embedQuery(原始 Query)
       → 再次检查索引 → VectorIndex.search()
       → sqlite-vec 逐条计算余弦距离 → 按 1 - distance 降序取 Top-K
```

BM25 使用 FTS5 默认分词器，中文未做专门分词处理。向量查询对指定来源做精确扫描；向量未配置、配置不兼容、索引缺失向量或编码失败时抛出错误。

两种方式经 `rowToHit()` 返回 `text`、`score`、`sourceType`、`sourceId`、`location`。分数越大越相关，算法间分数独立解释。摘要身份为 `sourceType + sourceId`，文档块再加 `location.chunkIndex`。当前每次执行单路召回并返回该路排序。

### Extension 集成层

| 生命周期或工具 | 调用与等待关系 |
| --- | --- |
| `session_start` | 等待旧扫描和摘要任务，关闭旧连接；打开项目数据库，创建服务，启动摘要向量补建和文档扫描、向量同步 |
| `before_agent_start` / `context` | 用户输入触发摘要 BM25 检索；命中结果临时追加到每次请求上下文 |
| `agent_end` | 按 `pendingSummary` 队列调用 `MemoryService.syncSession()`；该函数保存摘要后补建缺失向量，处理器等待完成 |
| `memory_search` | 等待 `pendingSummary`；按 `mode` 搜索摘要，`topK` 默认 5，工具允许 1–100 |
| `memory_read` | 直接读取指定会话中最新三条匹配 User/Assistant 消息 |
| `rag_search` | 等待 `scan`；按 `mode` 搜索文档块，`topK` 默认 5，工具允许 1–100 |
| `session_shutdown` | 等待扫描与摘要任务，关闭 embedding HTTP 连接及数据库，清空服务和候选 |

Extension 捕获后台扫描、摘要同步与向量构建错误并通过 UI 通知。底层服务负责返回结果或抛出错误，可脱离 Agent 运行循环独立调用。
