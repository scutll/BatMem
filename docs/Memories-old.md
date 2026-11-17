# DocsRAG & Cross-Session Memory

## 总体架构

基于 Pi Agent 的 Extension API，实现两项独立的上下文增强能力：

- **Cross-session Memory**：对历史 Session 建立摘要与原文索引，支持跨会话检索、历史信息恢复和任务上下文延续。
- **Document RAG**：对不同来源的文档进行统一解析、切块和索引，支持 Agent 根据 Query 检索相关文档内容。

两者都使用 SQLite 存储、全文检索和统一检索接口，但分别维护数据模型与索引。

本质上，Session Memory也可以看作是一种文档，因此也可以使用SQLite和相同的搜索或向量化机制

Pi Extension 负责连接 Agent 生命周期、注册检索工具和管理上下文注入；具体的数据处理与检索逻辑由独立模块实现。

---

## Cross-session Memory

### 数据来源与存储

以 Pi Session JSONL 为原始数据来源，读取历史会话中的用户消息、Assistant 消息和工具调用结果。

记忆采用两种互补的存储形式：

- **Session Summary**：通过 LLM 总结整个 Session 的主要讨论内容、重要决策、任务进度、结论与未完成事项。
- **Session Raw**：保留原始会话记录，并对消息内容建立可检索索引，以支持精确细节查询。

SQLite 保存 Session 元数据、Summary 和消息索引，同时保留原始 Session ID、Entry ID 等来源信息。

### 记忆构建与更新

Summary 在 `agent_end` 事件触发后建立或更新。Extension 通过 `ctx.sessionManager.getEntries()` 获取完整记录，构造 `SessionSnapshot` 传入 `syncSession()`；服务本身不读取 Session 文件。

当前将一个 Session 作为一个完整会话处理，不引入分支选择、归属检查或回溯逻辑。

- 每个 `sessionId` 维护一份当前 Summary，`leafEntryId` 记录上次摘要包含的最后一条消息，作为增量处理游标。
- 首次同步使用全部有效消息生成摘要；后续使用旧 Summary 和游标之后的新消息更新摘要；没有新消息时不调用摘要模型。
- 原文先入库；摘要生成成功后一起保存摘要正文和游标。摘要失败时保留原文及旧摘要，不自动重试。
- Summary 更新后，为新正文生成 embedding 并更新对应向量；旧正文的向量不能继续作为当前摘要的检索依据。向量构建状态与摘要处理游标分别维护，不能因为摘要已完成就跳过缺失向量的补建。


### 记忆检索

使用 SQLite FTS5 对 Session Summary 建立 BM25 全文索引, 同时通过SQLite-vec 插件 建立对 Summary Embedding 建立索引

Session Raw Message通过字符串匹配寻找。

SQLite的db文件创建于对话所属项目内文件夹，因此跨会话的范围应是限定于对话所属项目中

检索机制分为两个层次：

- **Summary Search**：根据 Query 搜索相关历史会话的摘要，摘要还携带Session信息以便后续使用`memory_read`精细搜索对话内容
- **Raw Search / Read**：通过 `sessionId + 关键词` 按字面子串匹配原文，返回最近三条 Assistant/User 消息；工具结果不占返回名额。本轮不对 Raw Message 建立向量索引。

检索结果携带 Session ID、Entry ID、时间及原文定位信息。

### Agent 集成

通过 Pi Extension 提供两种记忆访问方式：

**主动检索**

注册 `memory_search` 和 `memory_read` 工具，由 Agent 自主决定何时搜索历史会话或读取具体消息。

**自动检索**

在 `before_agent_start` 中，根据用户当前输入检索相关历史 Session Summary，并通过 `context` 事件将检索结果临时加入模型上下文，不持久化到 Session ，并避免重复注入（后续还可以考虑检查Context中是否已有该Summary，但是现在不考虑这个）。

注意并非所有用户输入都需要自动检索相关历史对话信息，因为用户完全可能发起与以往对话完全无关的新话题，因此需要通过一定的阈值筛选来确定候选的注入Summary, 即相关程度达到一定阈值才进行注入。这里我们后续再考虑阈值，当前可以直接自动注入分数最高的一条Summary。

------

## Document RAG

### 文档来源与解析

将不同格式的文档统一转换为可索引的文本及元数据。

先只支持本地 Markdown 文件，默认目录为项目下的 `.pi/docs-memory/documents`，在启动时通过异步任务扫描是否有更新。

**(后续)不同资源通过Extension命令导入(如URL)，或通过放入默认文件夹自动扫描并建立索引**

解析结果统一表示为 Document，包含：

- 文档 ID、来源与路径
- 文档内容及结构
- 定位信息`documentId, sourcePath, startLine-endLine, chunkIndex`
- 文件更新时间与内容哈希

保留原始文件作为内容来源。

### 文档切块

通过 Chunker 将解析后的文档划分为适合检索的文本片段。

初始采用固定长度500字符、overlap100的文本切块方式，并保留 Chunk 与原始 Document 的关联。

每个 Chunk 包含：

- Document ID 和数字类型的 chunkIndex，两者共同定位一个 Chunk
- 文本内容
- 文档来源与位置信息
- 所属章节等元数据

根据文档内容哈希检测变化，对新增、修改或删除的文档更新索引。

### 文档索引

同一批 Chunk 同时作为 BM25 和向量检索的数据来源，不为两种检索方式分别切块。

```text
Markdown → Chunker → Chunk 文本与来源坐标 → SQLite / FTS5
                                  └→ Document Embedding → sqlite-vec
```

新增文档建立文本和向量索引；修改文档替换 Chunk 并使旧向量失效，再为当前内容生成向量；删除文档时同时清理文本、全文索引和对应向量。内容与 embedding 配置都未变化且向量完整时，不重复编码。

### 文档检索

可以通过BM25 / Vector 实现两种搜索方式

与Cross-Session Summary共用搜索接口。

检索流程：

```
Query → BM25/Vector Search → Top-K Chunks → Source Metadata → Agent
```

检索结果包含相关文本、匹配分数、文档来源以及原文定位信息。

Agent可以通过`read()`阅读更多指定的文本内容，因此先不开发另外的读取工具

### Agent 集成

通过 Pi Extension 注册文档检索工具：

- `rag_search`：根据 Query 搜索相关文档片段与chunk定位信息。

Agent 根据任务需要自主调用检索工具，将获得的文档内容作为回答或执行任务的参考依据。

------

## 公共基础设施

### 存储层

通过 SQLite + sqlite-vec 分别存储文本和向量数据。sqlite-vec 是加载到 SQLite 连接中的扩展，向量与文本保存在同一个项目数据库 `.pi/docs-memory/index.db` 中，不需要独立数据库服务。

Cross-session Memory 和 Document RAG 分别维护各自索引数据，避免不同来源的数据混淆。

原始 Session JSONL 和文档文件不由索引数据替代。

### Embedding 生成与更新

当前Embedding生成通过Http接口访问https://api.jina.ai/v1/embeddings来实现，使用`jina-embeddings-v3`模型，向量维度为`1024`, 模型参数量`570M`

Embedding 模型独立于摘要和回答模型配置，负责将 Session Summary、Document Chunk 和查询文本转换为向量。

- 区分 document 和 query 两种编码用途，由模型适配层处理各自所需的前缀或指令；查询向量必须与被查询索引使用兼容的模型和编码配置。
- 文本分批编码，校验返回数量、顺序映射、维度及数值有效性，再写入向量索引。等待模型响应期间不持有 SQLite 写事务。
- 索引记录模型标识、维度、编码配置和内容版本。同维度不代表模型兼容；模型或编码配置改变后，需要重建对应向量，不能混用旧索引。
- 写入前检查内容版本，避免模型响应期间正文已更新，随后又写入过期向量。
- 生成失败不撤销已保存的文本和 BM25 索引；保留可识别的未完成状态，后续可补建缺失向量，不自动重试模型请求。

长文本超过模型输入限制时，应采用明确的处理策略并记录配置，不能静默截断或改变原有检索单元身份。具体模型、批量大小和输入长度策略在接入时确定。

### 检索接口

两个模块共享基础检索抽象。

BM25 与向量检索接收 `RetrievalQuery`（`query`、`topK`），返回有序的 `RetrievalHit[]`。文档结果继续使用带完整 Chunk 坐标约束的 `DocumentRetrievalHit[]`。模型调用是异步操作，对外搜索入口统一采用 Promise。

RetrievalHit 包含文本内容、匹配分数、来源类型、来源 ID 和原文定位信息。

目标分数约定为越大越相关，结果按相关性降序返回；BM25 对 SQLite 原始分数取负而不改变排名，向量检索返回相似度。不同算法的分数不可直接比较或相加，也不是概率。现有代码的 BM25 原始分数约定将在本轮同步调整。

文档结果由 `sourceType + sourceId + location.chunkIndex` 区分，Session 当前摘要由 `sourceType + sourceId` 区分。同一检索单元在 BM25 与向量检索中保持相同来源身份，便于后续融合与重排。

Memory 与 Document 分别维护数据及来源坐标，复用 embedding 和检索基础能力。现有 `memory_search`、`rag_search` 是 Agent 工具名称，与下述服务入口区分。

对外服务入口规划：

| 入口 | 行为 | 开发阶段 |
| --- | --- | --- |
| `search` | 对原始 Query 执行 BM25 检索 | 本轮统一入口，复用已有实现 |
| `vsearch` | 对原始 Query 编码后执行向量检索 | 本轮新增 |
| `query` | 按配置组织扩写、多路召回、融合和重排 | 后续实现，本轮不添加空实现 |

未配置 embedding 时可继续使用 `search`。显式调用 `vsearch` 时，模型不可用、索引未就绪或编码失败应报告错误，不伪装成无匹配结果，也不在底层偷偷切换 BM25。上层若选择降级，应明确记录实际检索方式与原因；评测默认不允许静默降级。

SQLite本身已经通过FTS5具备对query进行分词并用BM25搜索的能力，因此不需要自己实现BM25检索逻辑(对中文的支持程度较弱，但现在暂时不作其他考虑)

### 后续检索能力

Query expansion 由搜索流程负责，将原问题转换为额外查询；召回函数只接收查询文本，不需要知道它是否来自扩写。多路召回保留每路独立的 `RetrievalHit[]` 排名，RRF 再按检索单元身份融合；rerank 根据原问题对结果重新评分和排序。两个步骤继续操作 `RetrievalHit`，保留文本和来源坐标。

本轮只完成独立的 BM25 / Vector 检索，不实现扩写、融合、重排或通用流程引擎。评测调用统一搜索入口并消费有序结果，后续增加检索策略时尽量保持结果导出与评分逻辑不变。

### Extension 集成层

Extension 负责：

- 使用 `pi.registerTool()` 暴露 Agent 工具。
- 通过 Pi 生命周期事件触发记忆同步和自动检索。
- 通过 `context` 事件管理检索信息的临时上下文注入。
- 将检索、索引等操作委托给独立的 MemoryService 和 RAGService。

底层服务不直接依赖 Pi Agent 的运行循环，使其能够被独立调用与测试。
