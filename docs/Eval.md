# Evaluation 评测方案

BatMem 采用两层评测：**RAG Retrieval Eval** 检查共享检索模块的召回与排序，**Cross-Session Memory Eval** 使用 LongMemEval 检查 Agent 从历史会话中获取证据并回答问题的能力。

两者复用 `src/` 下的入库与检索实现。本节先说明记忆和搜索的实际运行路径，再说明评测如何调用这些能力。

## 记忆运行机制与搜索架构

### 数据与服务

扩展入口为 [`src/index.ts`](../src/index.ts)。每个项目使用 `<cwd>/.pi/docs-memory/index.db`，文档扫描目录为同级的 `documents/`。原始 Session JSONL 和 Markdown 文件继续保留，SQLite 保存可检索的文本及来源信息。

| 模块 | 职责与存储 |
| --- | --- |
| `MemoryService` | `sessions` 保存会话来源，`messages` 保存消息文本，`summaries` 为每个会话保存一条当前摘要及处理位置 |
| `RAGService` | 扫描 Markdown，以内容哈希判断变更，将文档和切块保存到 `documents / chunks` |
| `SearchService` | 提供异步 `search()` 和 `vsearch()`，分别调用关键词与向量检索器 |
| `VectorIndex` | 分批生成缺失向量，写入 `embeddings`；`embedding_config` 保存数据库当前使用的编码配置 |
| `openDatabase()` | 初始化表、FTS5 全文索引及触发器；启用外键、WAL 和 5 秒锁等待 |

`retrieval_units` 视图统一投影会话摘要和文档块，并通过 `source_type = memory / document` 区分来源。消息原文供摘要生成和定向读取使用；搜索的记忆单元是会话摘要。

### 会话生命周期与函数路径

```text
session_start
  → openDatabase() → MemoryService / RAGService / SearchService
  → 配置了 embedding 时，补建已有摘要的向量
  → scanDocuments() → indexDocument() → chunkMarkdown() → replaceDocumentIndex()
  → 配置了 embedding 时，补建文档块向量

before_agent_start（用户输入）
  → memorySearch.search({ query: prompt, topK: 1 }) → 本轮候选摘要
context（每次模型请求）
  → 将候选摘要作为参考消息追加到请求上下文

agent_end
  → SessionManager.getEntries() → SessionSnapshot
  → MemoryService.syncSession() → generateSessionSummary()
  → 保存摘要及处理位置 → 补建摘要向量

session_shutdown
  → 等待扫描和摘要任务 → 关闭 embedding 连接及数据库
```

`syncSession()` 先提取并提交 user、assistant、toolResult 消息，保留文本块和序列化的工具调用。首次同步用全部消息生成摘要；后续将旧摘要与处理位置之后的新消息交给当前 Pi 模型。生成成功后，摘要和 `leaf_entry_id` 一起更新；没有新消息时跳过摘要调用。生成失败时保留已提交消息、旧摘要和旧处理位置，后续同步可再次处理这些消息。

例如，上一轮已处理到消息 B，本轮新增 C、D，摘要输入就是“旧摘要 + C、D”；成功后处理位置推进到 D。摘要更新由扩展串行执行，避免旧任务覆盖新结果。

启动时的文档扫描和摘要向量补建作为后台任务发起，自动注入读取当时可用的摘要索引。自动注入固定使用 BM25 Top-1，搜索范围包含本会话摘要，且没有相关性阈值。同一轮模型请求复用该候选；自动追加的证据仅存在于请求上下文。Agent 还可主动调用工具：

| 工具 | 当前行为 |
| --- | --- |
| `memory_search(query, topK?, mode?)` | 等待摘要同步，搜索会话摘要；默认 `topK = 5`、`mode = search`，工具允许 Top-K 为 1–100 |
| `memory_read(sessionId, keyword)` | 在指定会话中按区分大小写的字面子串匹配，返回最新三条 user/assistant 消息；同时间按插入顺序倒序，空关键词返回空数组 |
| `rag_search(query, topK?, mode?)` | 等待文档扫描，搜索文档块；默认值与 `memory_search` 相同，结果带原文件路径和行号 |

文档在 `session_start` 递归扫描 `.md` 文件。每个变更文件单独提交完整切块替换；切块上限为 500 个 UTF-16 代码单元，相邻块重叠 100，保留行号和当前标题。扫描全部成功后清理已删除文件的索引。

### 共享搜索路径

```text
memory_search / rag_search / RAG 评测
  → SearchService
    ├─ search() → BM25Retriever → summaries_fts / chunks_fts
    └─ vsearch() → VectorRetriever
                   → VectorIndex.assertReady() → embedQuery()
                   → 再次检查完整性 → VectorIndex.search()
  → rowToHit() → RetrievalHit[]
```

`search()` 从查询中提取字母、数字和下划线组成的词，逐词加引号并用 `OR` 连接，交给 SQLite FTS5 的默认分词器匹配。结果按取负后的 BM25 分数降序排列。

`vsearch()` 将原始查询编码为向量，通过 sqlite-vec 对指定来源的已存向量做精确余弦距离扫描，以 `1 - distance` 作为分数降序排列。两条路径都返回文本、分数、来源 ID 和定位信息；不同算法的分数各自用于排序。

默认 embedding 配置为 Jina `jina-embeddings-v3`、1024 维、归一化向量；摘要和文档块使用 `retrieval.passage`，查询使用 `retrieval.query`，输入保持完整。配置读取 BatMem 根目录 `.env`，同名文件值优先于进程环境；`JINA_API_KEY` 启用向量能力，`HTTPS_PROXY / HTTP_PROXY` 配置其代理。

文本变化通过数据库触发器更新 FTS 并使对应向量失效。`syncEmbeddings()` 默认每批 32 条，只补建缺失向量，保存前再次核对来源和正文。向量检索要求来源索引完整且编码配置匹配，否则报错。Jina 请求每次超时 10 秒，对可重试错误最多重试三次，HTTP 429 后等待 20 秒。

## RAG Retrieval Evaluation

### 评测方式简述

针对固定语料和查询，调用生产 `SearchService`，将前 K 项结果与相关性标注 Qrels 比较。该评测覆盖入库、检索和排序，评分阶段使用文档 ID。

```text
BEIR → DatasetLoader → 构建或复用索引 → search / vsearch
     → retrieval.jsonl + manifest.json → Python 评分 → 指标
```

### 检索方式选择

CLI 参数为 `--mode search|vsearch`，PowerShell 对应 `-Mode`，默认 `search`。`search` 使用文本与 FTS 索引；`vsearch` 先补齐整个语料的文档向量，再逐条编码查询。运行清单的 `retriever` 记录所用方式。

### 当前构建缓存与恢复

build 保存可复用索引，run 保存单次查询及评分结果。CLI 默认 build 根目录为 `eval/rag/builds`，可通过 `--builds` 修改。

`fingerprintCorpus()` 对索引格式版本及按顺序准备好的 `{ id, text }` 计算 SHA-256 指纹。语料内容或顺序变化会产生新 build；Query、Qrels、split、Top-K 和检索代码变化可继续复用原 build。向量按同一 build 内的检索单元保存。

`prepareCorpusBuild()` 获取 `build-lock.db` 的 SQLite 写锁，持有至本次检索结束。文本完整导入后在 `eval_corpus` 写入检查点，并校验文档和切块数量。文本导入中断时重新导入该 build 的语料；向量构建中断时保留已提交批次，下次只补齐缺失向量。编码配置与已有索引不匹配时停止运行。

```text
eval/rag/builds/<fingerprint>/
  index.db                 # 正文、FTS、向量及数据库检查点
  build-lock.db            # 构建与查询的互斥锁
  build-manifest.json      # text-ready / vector-ready 构建说明

eval/rag/runs/<run-id>/
  retrieval.jsonl          # 查询、排名、ID、分数、正文和 Qrels
  manifest.json            # 完成状态、构建引用、参数、数据/代码哈希和运行版本
  query_metrics.jsonl      # 逐查询指标
  metrics.json             # 指标的逐查询平均值
```

每次检索使用新的 run 目录；`manifest.json` 在全部查询导出成功后写入。构建中断后使用相同数据和 build 根目录、新 run 目录重跑；查询向量每轮重新生成。

### 评测数据集来源

当前适配器为 [`BeirDataset`](../eval/rag/beir.ts)，读取本地 [BEIR](https://github.com/beir-cellar/beir) 目录中的 `corpus.jsonl`、`queries.jsonl` 和 `qrels/<split>.tsv`。

每条 corpus 记录保留 `_id`，非空标题和正文以换行连接，整条记录作为一个文档块。查询集保留所选 Qrels 划分中有标注的查询，并校验标注指向的语料 ID。

### 评测指标

设前 K 项实际返回集合为 R，正相关标注集合为 G，第 i 项是否相关为 vᵢ，相关性等级为 relᵢ。Qrels 大于零表示相关，未标注和非正等级的增益为零。

| 指标 | 计算与含义 |
| --- | --- |
| ID Precision@K | `count(R ∩ G) / count(R)`，衡量实际返回结果的相关比例 |
| Recall@K | `count(R ∩ G) / count(G)`，衡量找回的相关文档比例 |
| CP@K | `Σ(P@i × vᵢ) / Σvᵢ`，其中 `P@i = Σⱼ₌₁ⁱ vⱼ / i`，衡量相关结果所在位置的精确率 |
| MRR@K | 首个相关结果排名倒数的查询均值，前 K 项没有相关结果时记零 |
| nDCG@K | `DCG@K / IDCG@K`；`DCG@K = Σ(2^relᵢ - 1) / log₂(i + 1)`，IDCG 按全部标注的理想前 K 排序计算 |

空结果和没有正相关标注的查询各项记零；后者单独计数。ID Precision 的分母为实际返回数量。各指标最终按查询等权平均。

### 评测框架提供的接口

[`score_rag.py`](../eval/rag/score_rag.py) 使用固定版本 `ragas==0.4.4` 的 `SingleTurnSample`、`IDBasedContextPrecision` 和 `IDBasedContextRecall`；CP、MRR 和 nDCG 在脚本中计算。评分读取已导出的排名和 Qrels，同一份导出可重复评分，无需模型请求。

### Extension 与评测接口

| 文件 / 函数 | 调用路径 |
| --- | --- |
| `dataset.ts / DatasetLoader` | `readCorpus()` 提供 `{ id, text }` 异步流，`loadQueries()` 提供 `{ id, text, qrels }` |
| `build.ts / indexCorpus()` | 将每条记录包装为完整块，调用 `RAGService.replaceDocumentIndex()` |
| `build.ts / fingerprintCorpus()`、`prepareCorpusBuild()` | 确定语料身份，构建或打开共享索引 |
| `runner.ts / runRetrievalEval()` | 加载查询 → 准备 build → 校验 Qrels → 按需补建向量 → 组装 `SearchService` |
| `runner.ts / exportResults()` | 顺序调用选定搜索函数，按原排名导出每条查询，保留空结果 |
| `run.ts` | 解析 CLI，组装 `BeirDataset`、embedding 配置和 Runner |

## Cross-Session Memory Evaluation（LongMemEval）

### 评测方式简述

每道题使用独立项目和数据库，将其历史会话转为 Pi Session，调用生产记忆服务生成摘要。随后创建空白 Pi 会话，让 Agent 通过自动摘要注入、摘要搜索和原文读取回答问题，最后由模型 Judge 判分。

```text
prepare → build → answer → judge
历史转换   摘要建库   新会话问答   正确性判定与汇总
```

`--mode memory|no-memory` 控制是否加载 BatMem。`--retrieval search|vsearch` 独立选择摘要检索算法：自动注入和 `memory_search` 工具默认使用该算法，工具仍可显式指定 `mode`。`vsearch` 在 build 阶段补齐摘要向量，回答前验证索引完整；`no-memory` 不加载扩展或检索工具。

### 评测数据集来源

[`LongMemEvalDataset`](../eval/longmem/longmemeval.ts) 读取 [LongMemEval](https://github.com/xiaowu0162/LongMemEval) JSON 数组，将一条样本转换为问题、日期、类型、历史列表和参考答案。

| 数据字段 | 用途 |
| --- | --- |
| `haystack_sessions / haystack_dates / haystack_session_ids` | 按位置合并历史文本、会话日期和原始 ID |
| `question / question_date / question_type` | 问答输入、当前日期和分类统计 |
| `answer / answer_session_ids` | Judge 参考答案及证据会话映射，保存在 Agent cwd 外 |

历史消息只投影 `role / content`。导入器保留重复原始 ID 的每次出现，为每段历史分配独立 Pi Session ID。`--types` 先过滤题型，再按数据顺序取前 `--limit` 道题。

### 评测指标

Judge 按题型套用本地保存的官方 Prompt，输入问题、参考答案和 Agent 回答。输出严格解析为 Yes/No；明确判定才计入结果，所有题评分成功后写入汇总。

| 输出字段 | 含义 |
| --- | --- |
| `retrieval` | 本次记忆检索方式：`search`、`vsearch` 或无记忆的 `none` |
| `overall_accuracy` | 全部问题的正确比例 |
| `task_averaged_accuracy` | 本次出现的各题型正确率的等权平均 |
| `by_type` | 各题型的题数和正确率 |
| `abstention_accuracy` | ID 含 `_abs` 的不可回答问题的正确拒答率；无此类题时为 null |

题型为 `single-session-user`、`single-session-assistant`、`single-session-preference`、`multi-session`、`temporal-reasoning`、`knowledge-update`。

### 评测框架提供的接口

[`judge-prompts.json`](../eval/longmem/judge-prompts.json) 保存官方提交 `9e0b455f4ef0e2ab8f2e582289761153549043fc` 的 `get_anscheck_prompt()` 模板及来源哈希。`createJudgePrompt()` 选择模板，`judgeAnswers()` 经 Pi 模型运行时调用配置的评分模型，`summarizeJudgments()` 汇总二值判定。

Judge 通过 `question_id` 对齐已保存回答与参考答案；评分前校验回答完整性和唯一性。Judge 使用问题、答案及回答文本，Trace 用于单独诊断。

### Extension 与评测接口

| 文件 / 函数 | 职责 |
| --- | --- |
| `sessions.ts / writeHistorySessions()` | 生成并回读校验 Pi JSONL，保存原始 ID 与随机 Session ID 的映射 |
| `runner.ts / prepareBuild()`、`createEvaluationRun()` | 创建或扩展历史缓存，创建引用该 build 的 run |
| `runner.ts / prepareMemoryBuild()`、`buildMemory()` | 判断样本是否完成，逐个历史 Session 调用 `MemoryService.syncSession()` |
| `runner.ts / buildMemoryVectors()` | 在现有摘要数据库中只补建缺失向量，不重复调用摘要模型 |
| `pi.ts / createEvaluationSession()`、`runQuestion()` | 创建隔离的 Pi 会话，输入问题日期和问题，提取最终成功回答及用量 |
| `runner.ts / runMemoryEval()` | 逐题执行只读记忆问答，保存回答、失败记录和 Trace |
| `judge.ts / judgeAnswers()` | 校验回答、逐题判分并保存汇总 |
| `run.ts` | 组装 prepare、build、answer、judge 阶段与模型调用 |

### Session 转换与阶段衔接

`prepare` 将每段历史写成 Session Header 和顺序相连的消息 Entry，随机 ID 通过 `parentId` 串联。数据集的会话日期统一映射为 UTC；该会话所有消息共用这一时间，并保留原消息顺序。写入后通过 `SessionManager.open()` 回读校验。

`build` 校验历史文件哈希，通过 `loadSessionSnapshot()` 加载历史，每个完整会话调用一次 `syncSession()`，以 `session-final` 方式生成一条摘要。每题全部摘要完成、数据库关闭后发布 `memory-ready.json`。若选择 `vsearch`，同一阶段再检查已有摘要向量并补建缺失部分；向量调用失败时，已完成摘要和向量批次留在 build 中，重跑 build 继续补建。回答前再次检查向量是否完整。

`answer` 将该题 build 数据库复制到 run 内，以 run 的 `project` 为 cwd，通过 `createEvaluationSession()` 以 `evalMode` 加载真实扩展，使用 Pi 默认系统 Prompt。扩展入口跳过问答同步、向量补建和文档扫描；Agent 仍可在副本上搜索历史摘要并读取消息。`memory_search` 在评测中固定使用 run 的检索模式，即使模型传入另一种 `mode`。新 Session 和 Agent 状态也写在 run 内，`runQuestion()` 保存最后一条正常完成的 assistant 文本。build 阶段会按导入的历史 Session ID 清理旧评测遗留的问答索引，answer 阶段在副本上再次检查历史 Session 和摘要完整性。

`judge` 读取 `answers-<mode>.jsonl` 与 build 中的参考答案，保存逐题判定，再汇总指标。问答中的单题失败会被记录，整批有失败时禁止进入评分。

### 构建复用与产物

build 指纹包含数据集内容哈希、规范化题型筛选、摘要模型、摘要 Prompt 哈希、同步方式和构建格式版本，不包含检索模式。`search` 与 `vsearch` 因此复用同一批历史 Session 和摘要；向量模式只补建缺失向量。Limit 选择缓存样本的前缀：缩小可复用已有样本，扩大只追加缺失样本。代码哈希作为审计信息保存。run manifest 记录检索模式和 embedding 身份；分阶段运行及恢复必须与之匹配。

```text
eval/datasets/LongMemEval/builds/<fingerprint>/
  build-manifest.json
  samples/<序号>/
    sample.json                         # 问题、参考答案、历史 ID 映射与本机路径
    history/*.jsonl                     # 导入历史
    summary-usage.jsonl                 # 历史摘要请求用量
    memory-ready.json                   # 本题摘要建库完成标记
    project/.pi/docs-memory/index.db     # 消息、摘要、FTS5 与可选向量索引

eval/longmem/runs/<run-id>/
  run-manifest.json                      # build 引用、检索模式、embedding 身份及样本列表
  answer-config-memory.json              # 问答模型、检索模式和超时
  answers-memory.jsonl                   # question_id / hypothesis
  judge-results-memory.jsonl             # 逐题判定、评分模型和用量
  metrics-memory.json                    # 汇总指标
  samples/<序号>/
    answer-memory.json                   # 最终回答、主问答请求用量和耗时
    trace-memory.jsonl                   # 自动注入、工具调用/结果和实际系统 Prompt
    project/.pi/docs-memory/index.db      # 本次回答使用的独立索引副本
    agent/                              # 本轮 Agent 状态
    sessions/                           # 本轮新建 Session
```

无记忆模式使用 `no-memory` 文件后缀；失败时另写 `failures-<mode>.jsonl` 或 `judge-failures-<mode>.jsonl`。问答与逐题评分输出拒绝覆盖，重跑问答使用新的 run。摘要正文存于数据库，问答用量记录包含 Agent 主请求，历史摘要用量单独记录。

## 评测实现约定

- 生产扩展与评测复用 TypeScript 记忆服务、数据库触发器及检索器；RAG 指标通过导出文件交给 Python 计算。
- build 持有历史、摘要或语料索引，run 持有本次配置、回答、Trace 和指标。运行清单保存 build 引用，构建复用按数据与编码配置核对。
- 每道 LongMemEval 题独立建库。参考答案、证据映射和完整历史保存在 Agent cwd 外，问答上下文由新会话与检索结果组成。
- 比较 RAG 检索方式时固定语料、Query/Qrels 和 Top-K；比较记忆开关时固定样本及问答、评分模型，并分别保留结果。
- 排查记忆失败时，通过 `sample.json` 映射证据会话，检查 Trace 中自动注入的摘要、搜索参数与命中排名，以及实际执行的 `memory_read` 和返回内容。

## 数据集运行说明

以下命令从 BatMem 根目录执行，要求 Node.js 22.19+。LongMemEval 的模型参数必须对应 Pi 中已配置的模型。

### BEIR

首次准备 Python 评分环境：

```powershell
python -m venv eval/.venv
.\eval\.venv\Scripts\python.exe -m pip install -r eval/rag/requirements.txt
```

一键检索与评分；向量模式需配置 BatMem `.env` 中的 `JINA_API_KEY`：

```powershell
.\eval\rag\runbeir.ps1 .\eval\datasets\BEIR\scifact -Mode search -TopK 10 -Split test
.\eval\rag\runbeir.ps1 .\eval\datasets\BEIR\scifact -Mode vsearch -TopK 10 -Split test
```

脚本自动创建 `eval/rag/runs/<数据集目录名>--<编号>`，可用 `-BuildsDirectory` 指定缓存根目录。分开执行检索与评分：

```powershell
node eval/rag/run.ts --dataset eval/datasets/BEIR/scifact --mode search --output eval/rag/runs/scifact-001 --top-k 10 --split test
.\eval\.venv\Scripts\python.exe eval/rag/score_rag.py eval/rag/runs/scifact-001 --k 1 5 10
.\eval\.venv\Scripts\python.exe eval/rag/score_rag.py eval/rag/runs/scifact-001 --show-only
```

`--k` 最大为检索导出的 Top-K，省略时仅计算该最大值。检索使用新输出目录，评分和报告查看可重复执行。

### LongMemEval

一键执行四阶段：

```powershell
.\eval\longmem\runlongmem.ps1 -DatasetPath .\eval\datasets\LongMemEval\longmemeval_s_cleaned.json -Provider deepseek -Model deepseek-flash -Limit 5
.\eval\longmem\runlongmem.ps1 -DatasetPath .\eval\datasets\LongMemEval\longmemeval_s_cleaned.json -Provider deepseek -Model deepseek-flash -Limit 5 -Retrieval vsearch
```

脚本默认取前 5 题、`memory` 模式、`search` 检索和 `deepseek/deepseek-flash`，自动创建 `eval/longmem/runs/<数据集名>--<编号>`。`-Retrieval vsearch` 需要 BatMem `.env` 中的 `JINA_API_KEY`。`-Types` 筛选题型，`-BuildsDirectory` 指定缓存，`-OutputDirectory` 指定新 run，`-Mode no-memory` 跳过摘要建库。`-JudgeProvider / -JudgeModel` 单独指定评分模型，`-TimeoutMs` 设置问答和 Judge 超时，默认 120000 毫秒。每段历史仅在首次建库时调用一次摘要模型。

分阶段执行时，`prepare` 生成文件，其余阶段调用配置模型：

```powershell
$provider = "deepseek"
$model = "deepseek-flash"
$run = "eval/longmem/runs/lme-001"
node eval/longmem/run.ts --stage prepare --dataset eval/datasets/LongMemEval/longmemeval_s_cleaned.json --output $run --limit 5 --types multi-session --provider $provider --model $model --retrieval vsearch
node eval/longmem/run.ts --stage build --output $run --provider $provider --model $model
node eval/longmem/run.ts --stage answer --output $run --provider $provider --model $model
node eval/longmem/run.ts --stage judge --output $run --provider $provider --model $model
```

`--stage all` 按顺序执行四阶段。已有 run 可追加 `--stage answer --mode no-memory` 和对应的 `--stage judge --mode no-memory`，复用同一批样本做无记忆对照。

恢复中断的摘要建库，先确认原进程已退出：

```powershell
.\eval\longmem\runlongmem.ps1 -ResumeDirectory .\eval\longmem\runs\longmemeval_s_cleaned--1
```

恢复读取原 run/build 清单、摘要模型和检索模式；已完成的摘要建库跳过，向量模式仅补齐缺失向量。未完成摘要的样本重建该题数据库并重新生成历史摘要。完成后继续问答和评分。该入口要求 prepare 已完成且 answer 尚未启动；只恢复建库可单独执行 `run.ts --stage build`。build 内的样本保存绝对路径，应在原位置复用。
