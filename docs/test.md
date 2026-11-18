# BatMem 测试项

本文记录随功能迭代更新的测试要求，不代表所有条目已经实现或通过。当前支持摘要、原文读取、Markdown 切块、BM25、向量搜索和 eval 构建复用。本轮增加 query 多路召回框架及 embedding 透传 Processor，不实现 RRF、rerank 或 query expansion。下文原有“本轮新增”表格仍作为测试要求，实际接口以 `test/CONTRACT.md` 为准。

## 测试方式

- 使用临时目录和真实 SQLite；向量集成测试使用真实 sqlite-vec 查询，不 Mock 数据库排名。
- 摘要与 embedding 模型响应使用 Mock；HTTP 适配使用固定响应或本地服务，不读取真实密钥或调用付费模型。
- Memory 测试构造合法 SessionEntry 并包装为 SessionSnapshot；追加消息即在完整快照的 entries 末尾追加记录，无需真实 Session 文件。
- 一个 Session 作为一个会话处理，不引入分支归属、回溯、跨项目隔离或中文分词专项测试。
- BM25 与向量搜索统一返回 RetrievalHit；本轮目标 score 越大越相关。现有原生 BM25 升序断言需改为取负后的降序，并验证原排名不变。
- 下文“本轮新增”是待实现的测试要求，新增文件名在代码结构确定后落实。

## Cross-Session Memory

现有文件：`test/memory.test.ts`。

| 测试项 | 数据与操作 | 校验内容 |
|---|---|---|
| 首次创建摘要 | 构造包含用户、助手和工具结果的 SessionSnapshot；Mock 返回固定摘要 | 摘要输入包含有效消息内容；模型调用一次；摘要及处理位置正确保存 |
| 增量更新摘要 | 首次同步后追加消息，再次同步 | 输入包含旧摘要和新增消息，不重复发送旧消息原文；摘要与处理位置更新 |
| 重复同步 | 无新增消息时再次同步 | 不调用模型，不重复保存消息或摘要 |
| 摘要失败 | 首次或增量摘要 Mock 抛错或返回空白 | 不更新摘要和处理位置；原文仍可查询；不自动重试 |
| 摘要全文检索 | 为多个 Session 保存不同摘要，执行关键词查询 | 返回匹配摘要、相关性分数和来源信息；排序及 Top-K 正确 |
| 当前会话参与检索 | 当前及历史 Session 均有匹配摘要 | 不按当前 Session ID 排除结果 |
| 原文读取 | 一个 Session 内放入多条匹配消息，混合不同角色和时间 | 返回最近三条匹配的用户或助手消息；工具结果不占名额；来源定位正确 |
| 查询范围与边界 | 查询指定 Session、未知 Session，以及包含 `%`、`_` 的关键词 | 不串会话；无匹配返回空列表；原文关键词按字面子串匹配 |
| 持久化 | 同步后关闭并重新打开数据库 | 摘要和原文仍可查询 |

### 摘要向量索引（本轮新增）

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| 首次向量化 | 摘要 Mock 返回固定文本，embedding Mock 返回固定向量 | 编码的是 Summary 而非整段历史；关联正确 Session 和内容版本 |
| 摘要更新 | 新消息使摘要改变，再构建向量 | 新向量关联新正文，旧向量不再作为当前摘要返回 |
| 失败后补建 | 摘要成功、embedding 失败，再用无新增消息的快照恢复 | 不重复生成摘要；补建缺失向量；摘要游标不充当向量完成标记 |
| 重复同步 | 正文、模型配置不变且向量完整 | 不重复编码；向量缺失时仍可补建 |
| 向量查询 | 多个 Session 配置已知向量 | 排名、Top-K、Session ID、Entry ID、时间和路径正确 |
| 原文读取不变 | 建立摘要向量后调用 memory_read | 仍按字面子串读取最新三条用户/助手消息，不向量化 Raw Message |

## Markdown 切块

现有文件：`test/chunker.test.ts`。精确边界使用确定性短文本。

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| 固定长度切块 | 构造长度和换行已知的文本 | 每块最多 500 个 JavaScript UTF-16 code unit，相邻块重叠 100；正文保持原文切片 |
| 长度边界 | 空文件、短文本及 500、501、900、901 长度文本 | 块数量和尾块长度正确，无仅包含 overlap 的多余尾块 |
| 行号与序号 | 使用空行、LF、CRLF 和末尾换行 | chunkIndex 从 0 开始，行号从 1 开始且两端包含；末尾换行不增加覆盖行 |
| 章节信息 | 块跨越标题、从章节中间开始，代码围栏中含伪标题 | section 对应块起点的有效标题；围栏内容不作为章节 |

## Document RAG

现有文件：`test/rag.test.ts`。长文档从 `testDocs` 复制到临时目录后再修改，不改动原始资料。当前测试在目录缺失时使用 `docs/Memories.md` 副本，目录存在但为空则报错；替代资料测试不等于完成用户提供文档的验证。

| 测试项 | 数据与操作 | 校验内容 |
|---|---|---|
| 文档扫描 | 根目录、子目录放置 Markdown，同时放入其他格式文件 | 递归索引 Markdown，忽略其他格式 |
| 长文档定位 | 索引长 Markdown，检索已知内容 | 返回文本与原文切片一致，行号和章节可用于读取原文 |
| 重复扫描 | 文件不变，连续扫描两次 | 不重复创建文档或块，标识保持稳定 |
| 新增文件 | 首次扫描后加入新文档，再扫描 | 新文档可检索，已有文档保留 |
| 修改文件 | 替换关键词，保持文件大小和修改时间不变 | 通过内容哈希发现变化；旧内容退出索引，新内容可检索 |
| 删除文件 | 删除已索引文档，再扫描 | 清理文档、块及全文索引，不返回旧内容 |
| 扫描失败 | 让已索引目录暂时不可访问 | 报告失败，不误删已有索引 |
| 全文检索 | 创建相关程度不同的文档，执行查询 | 匹配内容、目标分数降序、同分稳定顺序、Top-K 和来源定位正确 |
| 查询边界 | 查询空白、无匹配词、特殊字符及非法 Top-K | 空白、无匹配及非法数量返回空数组；用户文本不被当作 FTS 操作符 |
| 持久化 | 建立索引后关闭并重新打开数据库 | 无需重新扫描即可查询已有内容 |

### 文档向量索引（本轮新增）

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| 同一批 Chunk | 对同一文档建立全文及向量索引 | 不为 vector 重新切块；两种结果保持相同文本、文档 ID、chunkIndex 和坐标 |
| 新增与重复构建 | 新增文档，随后重复相同构建 | 编码缺失文本；配置不变且完整的向量不重复生成 |
| 修改与删除 | 修改正文、减少块数量或删除文档 | 旧向量失效，新内容可检索，不返回已删除块 |
| 部分失败 | 前一批 embedding 成功，后一批失败 | 已完成记录保留，构建不标为完整；BM25 仍可使用已保存文本 |
| 过期响应 | 请求挂起期间更新或删除正文，再返回旧响应 | 不写入或返回与当前内容版本不一致的向量 |
| 持久化 | 关闭并重开数据库后查询 | 不重新编码文档；query 仍按需编码，来源坐标正确 |

## Embedding HTTP 与向量查询（本轮新增）

首个适配目标为 Jina `jina-embeddings-v3`。请求字段、task 和响应格式以接入时确认的契约为准。

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| 编码用途 | 分别执行 document/query 编码并捕获 Mock HTTP 请求 | 文本、模型及用途配置正确 |
| 批量映射 | 输入多段文本，返回可区分向量和不同响应排列 | 按服务的索引约定恢复顺序，不把向量关联到错误文本 |
| 非法响应 | 缺失数量、重复或越界索引、维度不一致、非法/非有限数值，余弦度量下零向量 | 拒绝非法数据，不发布成功构建 |
| HTTP 失败 | 鉴权失败、限流、服务错误、超时、无效 JSON | 明确报错，不自动重试、替换模型或切换检索方式 |
| 模型空间 | 更换模型、维度或 document 编码配置 | 不混用旧索引；同维度不同模型也不能直接兼容 |
| 长文本 | 输入超过模型限制的文本 | 执行并记录明确策略，不静默截断或改变检索单元身份 |
| 真实向量排名 | query 为 [1,0]，文档为 [1,0]、[0,1]、[-1,0]，使用余弦度量 | 真实 sqlite-vec 排名符合已知相似度，Top-K 与同分顺序正确 |
| 查询边界 | 空白 query、非法 Top-K、完整空索引、结果数量不足 K | 无效请求不调用模型；返回约定的空数组或实际数量 |
| 无关键词重合 | 文本不含 query 词，但 Mock 向量相似 | 向量查询不依赖 FTS 匹配；此项不证明真实模型的语义效果 |
| 来源身份 | 同一文档多个块，另有 Session 摘要 | 不按文档 ID 合并不同块；来源类型不混淆 |
| 索引不可用 | 缺少模型、扩展加载失败、向量缺失/未完成/不兼容 | vsearch 明确失败，区别于正常无结果；BM25 不依赖 embedding 配置 |
| 凭据处理 | 测试专用环境变量传入假密钥，检查输出 | 正确传递鉴权；密钥不进入日志、manifest、fingerprint 或结果 |

## 搜索入口与 Extension 接入（本轮新增）

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| search / vsearch | 对同一索引分别调用异步入口 | search 只执行 BM25，vsearch 编码 query 后查向量；统一返回 RetrievalHit 和分数方向 |
| 纯检索基线 | 捕获所有模型调用 | 两个入口均不执行扩写、融合、rerank；search 不调用模型 |
| 工具检索 | 离线模拟 memory_search、rag_search 调用 | 按配置等待异步搜索，保留结果来源信息 |
| 自动摘要注入 | 模拟 before_agent_start 和 context，使用已建摘要 | 等待异步检索后选排名首项；新一轮清除旧结果；注入不持久化、不重复累积 |
| 失败可观察 | 配置 vsearch 后模拟模型或索引失败 | 报告失败，不把 BM25 结果冒充为向量结果 |

## RAG Eval

现有文件：`eval/rag/test/eval.test.ts`、`eval/rag/test/test_score_rag.py`。保留数据和评分测试；retrieval 选择、embedding 与 build 复用为本轮新增。

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| Loader 解耦 | 内存 Loader 与临时 BEIR 文件 | Runner 不依赖 BEIR 格式，标准数据流可独立测试 |
| 完整检索单元 | corpus 记录超过 Markdown 块长度 | 不切块，保留原始 ID；向量输入处理不改变评测单元 |
| 数据校验 | 重复语料/Query ID、重复 Qrel、缺失证据 ID、非法记录 | 明确失败，不覆盖或发布完成结果 |
| retrieval 参数 | TS CLI、PowerShell 分别指定 bm25/embedding 和未知方式 | 正确选择生产入口；未知方式报错；manifest 保存指定与实际方式 |
| 导出一致性 | 两种检索返回不同排名，包含空结果 | 保留 query、连续 rank、document_id、score、text、qrels；不漏题、不按旧 BM25 规则重排 |
| 评分独立 | 保持 ID 排名与 Qrels，改变 score 数值 | 指标不变；Python 不调用模型或 SQLite |
| 指标边界 | 手算排名、多等级 Qrels、无命中、无正标注、结果不足 K | 符合 Eval.md 公式；nDCG 用指数增益；ID Precision 分母为实际返回数量 |
| 重复构建 | 同数据和配置执行两个 run | 复用语料、FTS 和向量；结果目录独立，不重复编码文档 |
| 查询侧变更 | 改变 Top-K、Query、Qrels、split、retrieval 或检索源码审计哈希 | 兼容构建身份不变；run 记录变化并重新查询 |
| 单元级复用 | 只增改一条语料；不同 build 含相同文本但不同 ID | 只编码缺失文本，可跨 build 复用；不同 corpus ID 仍独立检索 |
| 编码配置变更 | 改变模型、维度、document 前缀或处理规则 | 复用标准语料，构建受影响向量，不混用旧空间 |
| query 编码变更 | 只改变兼容的 query 编码配置 | 不重建文档向量；run 记录配置；不兼容空间拒绝查询 |
| 索引与执行配置 | 改 FTS 分词/向量索引配置，再改批量大小、并发数或假密钥 | 只重建受影响索引，复用 embedding；执行参数不改变内容缓存身份 |
| 中断补建 | 部分向量完成后中断，以新 run 引用同一缓存恢复 | 补齐缺失记录，不重编完整文本；未完成索引不能开始向量评测 |
| 缓存完整性 | 文件存在但标记缺失，或标记与产物/配置不一致 | 不仅凭文件存在判断完成；校验后补建或明确报错 |
| 实验隔离 | 两个 run 共用 build，尝试覆盖 run 或并发更新缓存 | 原结果不覆盖；共享更新串行或隔离，查询不读取混合索引版本 |
| 检索失败 | Mock 编码或向量查询异常 | 不静默降级、不缩小分母、不发布完成 manifest；保留构建用于恢复 |

## LongMemEval 接入

现有测试位于 `eval/longmem/test/`。保留 Session 转换、阶段衔接、摘要 build 复用、回答导出和 Judge 测试；向量接入时增加以下验证。

| 测试项 | 数据与操作 | 校验内容 |
| --- | --- | --- |
| retrieval 与 mode | 同样本分别选择 bm25/embedding 及 no-memory | 算法与是否使用记忆分开；配置持久化并在后续阶段恢复 |
| 摘要复用 | 已有摘要后切换 embedding 或更换向量模型 | 复用历史和摘要，只构建所需向量；检索源码改变不触发摘要重建 |
| 向量恢复 | 摘要完成、向量部分完成后恢复 | 不因缺少向量清空摘要 DB 或重调摘要模型，按内容补齐向量 |
| 完成状态 | 有 memory-ready 标记，但无完整匹配向量索引 | 不视为 embedding 就绪，完成向量构建后才问答 |
| 问答后恢复 | Faux 模型问答触发 Session 同步 | 恢复原文、摘要、向量的一致快照，避免测试会话污染缓存 |
| 导出与 Judge | 不同 retrieval 的答案进入现有 Judge 流程 | ID 对齐、缺失回答校验及评分契约不变；标准答案不进入可检索数据 |

## 执行与验收

### Query 已实现的离线覆盖

| 文件 | 覆盖 |
| --- | --- |
| `test/query.test.ts` | 三路并发启动、等待全部结束、同步/异步失败后排空任务、请求与并发调用隔离、路径校验、Processor 透传和错误传播 |
| `test/search.test.ts` | query 与真实 sqlite-vec 排名一致，BM25 排名不同不影响输出；保留不同 chunk 坐标，索引不完整时不编码查询 |
| `test/memory.test.ts` | query 等待启动补建，摘要游标正确，正文变化后拒绝不完整向量 |
| `test/extension.test.ts` | 普通 memory_search/rag_search 的 query 路径与无 provider 错误，调用方保留 provider 所有权 |
| `eval/rag/test/eval.test.ts` | search/vsearch/query 共享 build，query 与 vsearch 导出一致，记录 pipeline 与源码哈希，失败不发布完成 manifest |
| `eval/longmem/test/runner.test.ts` | query 复用摘要和向量，完整性检查在回答前执行，缓存与 run 副本隔离 |
| `eval/longmem/test/pi.test.ts` | 真实 Pi SDK + faux 模型 + 固定向量，query 自动注入与工具搜索，模型传入其他 mode 不改变固定评测模式 |
| `eval/longmem/test/judge.test.ts` | query 标识进入指标，Judge 不调用 embedding |

并发测试使用明确的任务启动信号和可控 Promise，不用 sleep 或耗时推断。query 的输出与 vsearch 相同只证明透传行为；另行检查两路执行及完整汇总。

现有测试命令如下，从 BatMem 目录执行；新增测试文件落地后同步补充。

```powershell
node --test test/memory.test.ts test/rag.test.ts test/chunker.test.ts test/embedding.test.ts test/vector.test.ts test/search.test.ts test/query.test.ts test/extension.test.ts
node --test eval/rag/test/eval.test.ts
.\eval\.venv\Scripts\python.exe -m unittest discover -s eval/rag/test -p test_score_rag.py
node --test eval/longmem/test/*.test.ts
```

`test/CONTRACT.md` 描述当前异步搜索、分数方向、Recall/Processor 和离线 provider 契约。BatMem 的 `npm run check` 独立覆盖 src、test 与 eval；仓库根类型检查不包含 BatMem。

固定向量和 Mock HTTP 验证程序行为，不证明 Jina 的实际召回能力。真实 BEIR/LongMemEval 由使用者明确发起，按 Eval.md 保存模型、retrieval、构建身份和指标；真实模型调用不进入默认自动化测试。展示结果时区分“测试通过”和“真实数据集评测成绩”。
