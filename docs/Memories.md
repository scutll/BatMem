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

Summary的建立在用户完成一次对话后进行，即`agent_end`消息发出的时候

通过Extension的 `ctx.sessionManager.getBranch()` 来获取上下文并重建整个(对话记录)

对对话记录进行摘要或摘要更新（取决于SQLite是否已经建立了该对话Branch的Summary）

当SQLite已经有对应Session的Summary, 则通过Summary + leafEntryId之后的新消息来更新摘要(需要判断leafEntryId是否属于当前分支路径)，如果还没有Summary就要全量摘要(先不考虑上下文长度过长)

Summary以`sessionId + leafEntryId`作为索引，`leafEntryId`标识该Session分支下最后一次摘要的消息，在寻找Summary的时候，可以通过回溯判断leafEntryId是否属于当前Branch
**在当前开发与测试中，Session与Branch之间的处理没有那么关键并且也要更复杂，因此当前的开发中，先考虑使用者不使用分支的情况，每个Session都只有一个分支，但是仍然使用SessionId + leafEntryId进行索引, 后者用于判断是否需要更新Summary**


### 记忆检索

使用 SQLite FTS5 对 Session Summary 建立 BM25 全文索引， Session Raw Message通过字符串匹配寻找。
SQLite的db文件创建于对话所属项目内文件夹，因此跨会话的范围应是限定于对话所属项目中

检索机制分为两个层次：

- **Summary Search**：根据 Query 搜索相关历史会话的摘要，摘要还携带Session信息以便后续使用`memory_read`精细搜索对话内容
- **Raw Search / Read**：通过`sessionId + 关键词` 搜索符合片段，返回字符串匹配的最近三条(Assistant/User)消息，这里只有SessionId, 在多分支的时候会在混合起来的各分支里面搜索相关关键词

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

先只支持本地Markdown文件，指定默认目录，并在启动时通过异步任务扫描是否有更新

**(后续)不同资源通过Extension命令导入(如URL)，或通过放入默认文件夹自动扫描并建立索引**

解析结果统一表示为 Document，包含：

- 文档 ID、来源与路径
- 文档内容及结构
- 定位信息`documentId, sourcePath, startLine-endLine, chunkIndex`
- 文件更新时间与内容哈希

保留原始文件作为内容来源。

### 文档切块与索引

通过 Chunker 将解析后的文档划分为适合检索的文本片段。

初始采用固定长度500字符、overlap100的文本切块方式，并保留 Chunk 与原始 Document 的关联。

每个 Chunk 包含：

- Chunk ID、Document ID
- 文本内容
- 文档来源与位置信息
- 所属章节等元数据

使用 SQLite 存储 Chunk 元数据，通过 FTS5 建立全文索引，支持 BM25 检索。

根据文档内容哈希检测变化，对新增、修改或删除的文档更新索引。

### 文档检索

先通过BM25实现Chunks检索，可以与Cross-Session Summary共用搜索接口。

检索流程：

```
Query → BM25 Search → Top-K Chunks → Source Metadata → Agent
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

统一使用 SQLite 存储元数据和检索索引。

Cross-session Memory 和 Document RAG 分别维护各自的数据表与 FTS5 索引，避免不同来源的数据混淆。

原始 Session JSONL 和文档文件不由索引数据替代。

### 检索接口

两个模块共享基础检索抽象。

Retriever 接收 Query、Top-K 和可选过滤条件，返回统一格式的 RetrievalHit。

RetrievalHit 包含文本内容、匹配分数、来源类型、来源 ID 和原文定位信息。

Memory Retriever 与 Document Retriever 分别实现自己的检索流程。

SQLite本身已经通过FTS5具备对query进行分词并用BM25搜索的能力，因此不需要自己实现BM25检索逻辑(对中文的支持程度较弱，但现在暂时不作其他考虑)

### Extension 集成层

Extension 负责：

- 使用 `pi.registerTool()` 暴露 Agent 工具。
- 通过 Pi 生命周期事件触发记忆同步和自动检索。
- 通过 `context` 事件管理检索信息的临时上下文注入。
- 将检索、索引等操作委托给独立的 MemoryService 和 RAGService。

底层服务不直接依赖 Pi Agent 的运行循环，使其能够被独立调用与测试。