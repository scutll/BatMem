# Test contract

这些测试约束 BatMem 的当前服务接口。测试使用临时目录、真实 SQLite/FTS5 和真实
sqlite-vec 查询；摘要与 embedding 响应使用固定 Mock，不读取真实 Session 文件、API
密钥，也不发起模型请求。

从 BatMem 根目录运行：

```powershell
node --test test/memory.test.ts test/rag.test.ts test/chunker.test.ts test/embedding.test.ts test/vector.test.ts test/search.test.ts test/query.test.ts test/extension.test.ts
```

## 公共接口

类型从对应契约文件导入：搜索为 `src/search/types.ts` 和 `src/search/processor.ts`，Embedding 配置及索引记录为 `src/embedding/types.ts`，扩展选项为 `src/types.ts`，Eval 运行接口为各自目录下的 `types.ts`。`QueryRecall` 抽象基类位于 `recall.ts`，具体组合位于 `bm25-embedding-recall.ts`；Processor 具体实现位于 `embedding-query-processor.ts`。实现文件不再兼容转导出已迁移的接口。

- `openDatabase(path)` 创建父目录并初始化文本、FTS5 和向量元数据表，返回由调用方关闭的
  `node:sqlite` 连接。
- `MemoryService(db, embedding?)` 可接收 Mock embedding provider。`syncSession(snapshot, summarize)`
  接收完整线性 Session 快照。首次摘要使用全部有效消息，增量摘要只使用旧摘要和游标之后的消息；
  模型失败不推进摘要游标。已配置 provider 时，摘要保存后补建向量；无新消息时也补建缺失向量。
  创建服务时通过 `ready` 等待已有摘要的向量补建。`searchSummaries(request, mode?)` 异步返回
  BM25（默认）、向量检索或 query 结果；query 等待启动向量补建。
- `MemoryService.readMessages(sessionId, keyword)` 按字面子串返回最近三条 User/Assistant 原文，
  不返回 Tool Result。
- `RAGService.scanDocuments()` 递归维护 Markdown 文档；`replaceDocumentIndex()` 可直接写入已准备的
  Chunk，不强制重新切块。
- `chunkMarkdown(text)` 生成最多 500 个 UTF-16 code unit、重叠 100 的 Chunk，并保留行号和章节。
- `BM25Retriever(db, source).retrieve({ query, topK })` 按 `memory` 或 `document` 查询 FTS5。
  SQLite 原生 BM25 取负后返回，因此分数越大越相关。
- `JinaEmbeddingProvider(options)` 对 document 使用 `retrieval.passage`，对 query 使用
  `retrieval.query`。响应必须按 index 完整覆盖输入，并通过数量、索引、维度和有限数值校验。
- `VectorIndex(db, provider, batchSize?)` 按来源补建向量。`syncEmbeddings(source)` 不在 HTTP 等待期间
  持有写事务；批次失败保留已完成数据；正文变化或删除会使旧向量失效；过期响应不能写回。
- `VectorIndex.getStatus(source)` 返回 `{ total, indexed, pending }`。`search(source, vector, topK)`
  仅在配置匹配且该来源完整时执行真实 sqlite-vec 余弦查询，返回分数降序结果。
- `VectorRetriever` 在 query 编码前检查索引状态，编码后再次检查，再执行来源限定的向量查询。
- `SearchService.search()` 只调用 BM25 Retriever；`vsearch()` 只调用 Vector Retriever。向量未配置
  或失败时明确报错，不静默返回 BM25 结果。
- `SearchService.query()` 默认使用 `BM25EmbeddingRecall` 并发执行 BM25 与 embedding 任务，
  `QueryRecall` 抽象类允许子类注册任意数量的 `{ path, run: async request => hits }`。
  各路请求独立，全部结束后按注册顺序汇总 `RecallResult[]`；失败时汇总错误，不执行 Processor。
- `QueryProcessor.process(request, results)` 接收原始请求与全部成功路径。
  `EmbeddingQueryProcessor` 每路先按来源身份去重、保留首次命中，再以去重后的排名计算
  `1 / (60 + rank)`；跨路累加并记录最好排名，第 1 名加 `0.05`、第 2～3 名加 `0.02`，
  奖励只加一次，按融合分降序选取前 `max(40, topK)` 个候选，不修改输入。
  构造时可注入 reranker，否则沿用 embedding 的 Jina 密钥和代理配置创建；没有密钥时为空。
  非空候选必须配置 reranker；请求全部候选的分数，以响应 index 映射回候选。
  最终分数为 `alpha / r + (1 - alpha) * rerankScore`，r 是从 1 开始的 RRF 排名；
  排名 1～3 的 alpha 为 `0.75`，4～10 为 `0.60`，其余为 `0.40`。
  混合后重新排序并返回 topK。Query 和 Search 测试注入离线 reranker，覆盖响应乱序和权重边界。
- 普通工具与真实 Pi SDK 评测使用注入的离线 provider；评测模式固定，模型工具参数不能覆盖。
  扩展不关闭调用方提供的 provider，evalMode 不补建向量、不保存问答摘要。

## 结果与测试边界

BM25 和向量检索统一返回 `RetrievalHit`。Memory 结果由 `sourceType + sourceId` 标识；Document
结果由 `sourceType + sourceId + chunkIndex` 标识。两种算法均按高分优先，但分数不能直接比较或
相加。

RAG 测试会先把 `testDocs` 复制到临时目录。目录不存在时使用 `docs/Memories.md` 的副本；目录
存在但没有 Markdown 文件时测试失败。所有修改和数据库文件都留在临时目录。

固定向量只验证请求、存储、失效、排名和来源映射，不证明真实 Jina 模型的语义召回质量。
真实 BEIR 和 LongMemEval 由 eval 命令单独运行。
