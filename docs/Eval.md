# Evaluation 评测方案

本项目采用两层评测体系：

- **RAG Retrieval Eval**：评估共享检索模块的召回与排序能力。
- **Cross-Session Memory Eval**：使用 LongMemEval 评估 Pi Agent 完整的跨会话记忆能力。

两套评测共享检索基础设施，但分别评估检索质量和 Agent 最终任务完成效果。

## RAG Retrieval Evaluation

### 评测方式简述

针对固定的文档语料库和测试 Query，调用 Extension 使用的 Retriever，将 Top-K 检索结果与 Ground Truth（标准相关证据）比较。

评测流程：

```
Dataset → Indexer → BM25 Retriever → Top-K Results → Metrics
```

### 评测数据集来源

- **BEIR**：[GitHub](https://github.com/beir-cellar/beir)：提供多领域文档语料、Query 和相关性标注（Qrels）。
- **自建 Document QA Dataset**：覆盖 Markdown、PDF、代码等文档，标注 Query 与相关 Chunk / Document ID 的对应关系。

### 评测指标

这里的K指的是召回前K项

#### Recall@K

用于衡量**在所有真正相关的文档中，前K个结果找到了多少**
$$
Recall@K = \frac{|R_K \cap G|}{|G|}
$$

- $R_K$: 检索系统返回的前K个结果
- $G$: 所有相关文档的集合

这里公式的意义就是$R_k$中能找到的相关文档占所有相关文档的比例

但这里不关心前K项中相关文档的排序，也就是**不关心文档的相关程度**

---

#### CP@K

**Context Precision**用于衡量检索系统**能否将真正相关的内容排在检索结果的前面**
$$
CP@K = \frac{\sum_{k=1}^K(P@k \cdot v_k)}{\sum_{k=1}^K v_k}
$$

- $K$: 检索结果的截断位置
- $P@K$: 前k个检索结果中的精确率, $P@k = \frac{\sum_{i=1}^k v_i}{k}$
- $v_k$: 第$k$个Chunk是否相关($1/0$)
- $\sum v_k$: Top K中相关Chunk的总数量

考虑上半部分，如果第$k$个结果相关，则获得$P@k$的分数，否则为0，下半部分是Top K里面相关的文档总数。

这里的计算思想是, **$P@k$代表了搜索到k篇文档时，检索结果的纯净程度，**而$CP@K$正式对这些$P@k$求平均，衡量整体的排列质量

CP@K跟Recall@K相比，**更考虑召回结果的排序质量，但是对召回度的衡量能力变弱，但它仍然不能衡量文档之间实际的相关程度差异**

---

#### MRR@K

**Mean Reciprocal Rank**, 平均倒数排名，衡量的是对于每个Query，检索系统**能否将第一个相关文档尽可能排在前面**

首先定义RR@K:
$$
RR@K(q)=
\begin{cases}
\frac{1}{r_q}, & r_q\le K\\[6pt]
0, & r_q>K\text{ 或不存在相关结果}
\end{cases}
$$

- $q$: 检索query
- $r_q$：第一个相关文档在检索结果的排名(从1开始)

这里第一个文档的排名越小，$RR@K$越大

然后对于N个query的测试集，
$$
MRR@K = \frac{1}{N}\sum^N_{i=1}RR@K(q_i)
$$
也就是所有$RR@K$的平均值

---

#### nDCG@K

**Normalized Discounted Cumulative Gain, 归一化折损累计增益**衡量的是检索系统**能否将相关程度更高的文档排在更靠前的位置**

这里会引入不同文档之间相关性的差异，即对每个Chunk设置一个相关性等级G

那么对这些等级相加就得到了$CG@K$, 但是`{1,2,3}`和`{3,2,1}`是一样的，而明显后者是更好的搜索结果。

因此有$DCG@K$:
$$
DCG@K=\sum_{i=1}^K \frac{2^{rel_i} - 1}{log_2(i+1)}
$$

- $rel_i$：第i个文档的相关性等级，上半部分就是文档的相关性增益(Gain), 显然文档增益随着相关性等级的提示是大幅度的
- $log_2(i+1)$：排名折损因子，因为**排名越靠后，文档的实际贡献就要越低**

最后进行归一化：
$$
nDCG@K = \frac{DCG@K}{IDCG@K}
$$
其中：
$$
IDCG@K = \sum^K_{i=1} \frac{2^{rel^*_i} - 1}{log_2(i+1)}
$$

- $rel_i^*$表示**理想排序下第i个文档的相关性等级**（还需根据标注文档构造理想排序）

nDCG解决的问题是不同query的相关文档数量、相关性等级不同，DCG的值难以反映不同query的实际效果

---

### 评测框架提供的接口

**Ragas（Python）**：[GitHub](https://github.com/vibrantlabsai/ragas)

- `IDBasedContextPrecision`：根据检索 ID 和标准证据 ID 计算集合式 Precision。
- `IDBasedContextRecall`：根据检索 ID 和标准证据 ID 计算 Recall。
- `SingleTurnSample`：旧版 API 中用于组织单条评测数据的结构。
- MRR@K、nDCG@K、排名敏感 CP@K 由评测模块自行实现。

正式接入时需锁定 Ragas 版本；其新版 collections API 与旧版接口不同。

**BEIR** 提供 `corpus / queries / qrels` 格式及标准检索指标计算工具。

### Extension#eval 需要提供的接口

当前 `eval/rag/runner.ts` 提供以下接口：

| 接口 | 功能 |
| --- | --- |
| `indexCorpus(rag, corpus)` | 接收异步语料流，将准备好的文本包装为一个完整 Chunk，调用生产入库接口建立索引，返回语料 ID 集合 |
| `exportResults(rag, queries, topK, resultPath)` | 批量调用 `rag.searchChunks()`，将 Query、按排名排列的 Top-K IDs、Scores、文本及 Qrels 写入 JSONL |
| `runRetrievalEval(options)` | 评测入口，接收 `loader / output / topK`，通过抽象 Loader 获取数据，组织独立数据库创建、入库、检索和结果导出，最后写入运行清单 |

单次搜索复用生产 `RAGService.searchChunks({ query, topK })`；目前没有独立的 `clear(namespace)` 接口，每次运行要求使用新的输出目录和 SQLite 数据库进行实验隔离。

`dataset.ts` 定义统一的 `DatasetLoader`、`CorpusRecord` 和 `EvaluationQuery` 接口。Loader 通过 `readCorpus()` 返回 `{ id, text }` 异步流，通过 `loadQueries()` 返回 `{ id, text, qrels }` 数组，并提供数据来源和索引规则用于运行清单。

`beir.ts` 的 `BeirDataset` 实现该接口，负责 BEIR 文件路径、读取、格式校验、标题与正文拼接，以及 Query/Qrels 关联。`runner.ts` 仅依赖抽象接口，不导入 BEIR 实现。`run.ts` 是命令行组装入口，创建 `BeirDataset` 后传给 Runner。接入其他格式时新增 Loader，在调用入口传入即可，无需修改 `runner.ts`。

TypeScript 检索和 Python 评分分两步独立执行，通过文件交换数据：

```text
运行 eval/rag/run.ts
  BeirDataset → DatasetLoader → runRetrievalEval()
  loader.readCorpus() → indexCorpus() → SQLite / FTS5
  loader.loadQueries() → 带标准标注的查询
  exportResults() → searchChunks() → retrieval.jsonl
  全部完成 → manifest.json

运行 eval/rag/score_rag.py
  manifest.json + retrieval.jsonl
    → Ragas 计算 ID Precision、Recall；自定义代码计算 CP、MRR、nDCG
    → query_metrics.jsonl（逐题指标）
    → metrics.json（各指标的逐题平均值）
```

`score_rag.py` 不调用 `runner.ts`，也不连接 SQLite 或重新读取原始数据集。Qrels 已随检索结果导出；Python 将其中分数大于零的文档 ID 转成 Ragas 的 `reference_context_ids`，将前 K 个检索 ID 转成 `retrieved_context_ids`。原始相关性等级保留给 nDCG 使用。同一份检索导出可以重复评分，无需重新入库或检索。

------

## Cross-Session Memory Evaluation（LongMemEval）

### 评测方式简述

将 LongMemEval 提供的历史对话转换为合法 Pi Sessions，经过真实 Memory Extension 完成 Summary 构建与索引。

随后创建新的 Pi Session，输入测试 Question，由 Agent 自主检索历史并生成回答。

使用 LongMemEval 官方 LLM-as-a-Judge 判断回答是否正确。

评测流程：

```
LongMemEval → Pi Session Adapter → Memory Extension → New Session + Question → Agent Response → LLM Judge → Accuracy
```

本评测关注完整的跨会话记忆能力，而不单独对 BM25 进行检索评分。

### 评测数据集来源

**LongMemEval-S**：[GitHub](https://github.com/xiaowu0162/LongMemEval)

提供 500 道长期记忆测试问题及对应的历史 Session、标准答案和证据标注。

主要数据字段：

| 字段                   | 用途                             |
| ---------------------- | -------------------------------- |
| `haystack_sessions`    | 历史会话数据                     |
| `haystack_session_ids` | 历史 Session 标识                |
| `haystack_dates`       | 会话时间信息                     |
| `question`             | Agent 需要回答的问题             |
| `answer`               | Judge 使用的标准答案             |
| `question_type`        | 记忆能力类别                     |
| `answer_session_ids`   | 正确证据所在 Session，供诊断使用 |

### 评测指标

LongMemEval 使用 LLM Judge 对每条回答进行二值评分（1/0）。

| 指标                        | 指标意义                       |
| --------------------------- | ------------------------------ |
| Overall Accuracy            | 所有测试问题的回答正确率       |
| Single-Session Accuracy     | 单会话历史事实恢复能力         |
| Multi-Session Accuracy      | 跨会话信息整合能力             |
| Temporal Reasoning Accuracy | 历史时间信息推理能力           |
| Knowledge Update Accuracy   | 历史事实更新与最新状态识别能力 |
| Preference Accuracy         | 用户长期偏好的理解与应用能力   |
| Abstention Accuracy         | 对不可回答问题正确拒答的能力   |

同时记录各类问题的正确率，便于识别具体记忆能力的不足。

### 评测框架提供的接口

**LongMemEval 官方评测脚本：**

- `evaluate_qa.py`：读取 Agent 回答和标准答案，调用 LLM-as-a-Judge 判断正确性。
- `print_qa_metrics.py`：汇总总体 Accuracy 和不同问题类型的 Accuracy。
- `get_anscheck_prompt()`：根据 Question Type 生成相应的评分 Prompt。

Judge 输入主要包括 `Question / Reference Answer / Hypothesis`，输出 Yes / No。

Agent 回答通过 `question_id` 和标准测试数据进行关联。

### Extension#eval 需要提供的接口

当前实现位于 `eval/longmem/`，与 RAG 检索评测独立：

| 文件 / 接口 | 功能 |
| --- | --- |
| `dataset.ts` / `MemoryDatasetLoader` | 定义历史会话、问题、参考答案的统一数据契约 |
| `longmemeval.ts` / `LongMemEvalDataset.readSamples()` | 流式读取官方 JSON 数组，校验并移除历史消息中的标注字段 |
| `sessions.ts` / `writeHistorySessions()` | 构造合法 Pi JSONL，保留历史时间和消息顺序，使用不含证据标签的 ID |
| `runner.ts` / `prepareBuild()` | 按类型筛选样本，创建或复用数据集 `builds/<fingerprint>` 缓存 |
| `runner.ts` / `createEvaluationRun()` | 创建只保存回答、Trace 与评分结果的运行目录 |
| `runner.ts` / `buildMemory()` | 每个历史 Session 调用一次生产 `MemoryService.syncSession()` |
| `pi.ts` / `createEvaluationSession()`、`runQuestion()` | 加载 BatMem，以 Pi 默认系统 Prompt 执行问题，提取最终文本并记录 Trace |
| `judge.ts` / `judgeAnswers()` | 使用固定版本官方评分 Prompt 和可配置模型，校验回答完整性后判分汇总 |
| `run.ts` | 解析阶段、模型及样本数参数，组装真实模型调用 |

历史日期没有时区，统一按 UTC 映射用于时间计算，并保留原始日期；同一 Session 不编造逐消息时间。当前模式为 `session-final`，即整场历史同步一次，与生产逐轮增量同步的结果应区别比较。

### Session 转换与阶段衔接

一条样本是一道问题及其多段历史会话。`--types` 可按 `question_type` 筛选，`--limit` 在筛选后限制题数；六种类型共用同一转换、建库和问答逻辑，不对答案做类型特判。运行按阶段批量串行执行：先创建或复用 build，再全部建库、全部回答，最后全部评分。

筛选顺序固定为：完整数据集 → `--types` 过滤 → 取前 `--limit` 条。未传 `--types` 时按原始数据集顺序取样，因此小范围默认运行可能恰好全部是 `single-session-user`，不代表数据集只包含该类型。

可选类型：`single-session-user`、`single-session-assistant`、`single-session-preference`、`multi-session`、`temporal-reasoning`、`knowledge-update`。

```text
prepare：LongMemEvalDataset.readSamples() → 按类型筛选 → build 指纹
         → prepareBuild() → history/*.jsonl + sample.json + build-manifest.json
         → createEvaluationRun() → run-manifest.json
build：  buildMemory() → SessionManager.open() → SessionSnapshot
         → MemoryService.syncSession() → 原文入库 + 摘要 LLM → SQLite / FTS5
answer： runMemoryEval() → build project 作为 Pi cwd → session.prompt(问题日期 + 问题)
         → 自动 Top-1 摘要注入 / memory_search / memory_read → answers-memory.jsonl
judge：  judgeAnswers() 读取已保存回答 + build 中 sample.json 的标准答案
         → 官方 Prompt + Judge LLM → judge-results-memory.jsonl
         → summarizeJudgments() → metrics-memory.json
```

数据适配将 `haystack_sessions[i] / haystack_dates[i] / haystack_session_ids[i]` 合并为 `{ id, date, messages: [{ role, content }] }`。消息仅保留角色和文本，去掉 `has_answer` 等标签。每段历史转换为一个 Pi JSONL：首行是 Session Header，其后每条消息一个 Entry；生成随机 Session/Entry ID，通过 `parentId` 串联顺序，首条消息的父 ID 为 `null`。

数据集只有会话级日期，因此 Header 和所有 Entry 共用该会话日期的 ISO 时间，内部 `message.timestamp` 使用对应 Unix 毫秒数。User 正文保留字符串，Assistant 正文转换为文本块并补齐模型、停止原因及零用量字段。写入后用 Pi `SessionManager` 重新加载校验；`syncSession()` 接收快照，不自行读取文件。

历史和参考答案保存在 Agent cwd 外。回答 Agent 的 cwd 是该题 build 中的 `project`，因此 Extension 会访问已构建的 SQLite；新 Pi Session 文件和 Agent 配置写入 run 目录。回答结束后恢复 SQLite 快照，避免问答 Session 被同步进可复用缓存。`no-memory` 同样使用该 build project 作为 cwd，但不加载 BatMem，因而不打开或修改缓存 DB。`answer_session_ids` 保留用于校验和诊断，当前不据此计算检索指标。

回答逐题持久化后才进入 Judge，按 `question_id` 对齐问题、标准答案和 `hypothesis`。Judge 不读取完整历史或 Trace；逐题保存明确的 Yes/No，全部成功后才计算总体及分类准确率。因此可以单独运行 `judge`，无需重新建库或问答。

Judge 模板取自官方提交 `9e0b455f4ef0e2ab8f2e582289761153549043fc` 的 `get_anscheck_prompt()`，保存在 `judge-prompts.json`；来源哈希和 MIT 许可证同时保留。调用改为 Pi 模型运行时，以复用 DeepSeek 等模型配置和鉴权。判定只接受明确的 Yes/No（可带句点或感叹号）；模糊输出记为评分失败，不沿用官方简单包含 `yes` 的判断。

需要保证：

- 保留原始 Session 时间和对话顺序。
- Ground Truth 不进入 Agent 可访问的记忆。
- 每个测试样本使用独立记忆环境。
- 历史信息必须通过真实 Memory Extension 检索获得，而非直接注入完整历史。
- 记录 Retrieval Trace，以便分析回答失败的原因。

------

## 评测实现约定

- **生产实现语言**：TypeScript，Extension 和评测 Runner 共享底层 Memory / Retrieval Service。
- **RAG 评测**：TS 执行检索，JSONL 交换结果，Python Ragas 或标准 IR 指标实现负责评分。
- **LongMemEval 评测**：TS 负责数据转换、Pi Agent 执行与回答导出，并通过 Pi 模型运行时执行官方 Judge Prompt；不依赖 Python 评分环境。
- **实验可复现性**：固定 Dataset、模型、Prompt、检索参数及索引版本，保存逐题结果与最终指标。
- **对照实验**：长期记忆至少比较 No Memory、Raw Retrieval、Summary Retrieval、Summary + Raw 四种配置。

最终，RAG Retrieval Eval 验证**检索算法是否有效**；LongMemEval 验证**Agent 能否利用跨会话记忆正确完成问答任务**。



---



## 数据集运行说明

### BEIR

每条 corpus 记录作为一个完整检索单元，不执行 Markdown 扫描或切块。保留 `_id`，非空标题和正文以换行连接，使用生产 `RAGService` 入库和搜索。

**一键运行（Windows PowerShell）**：首次按下方说明创建 Python 环境并安装依赖后，只需指定数据集目录

```powershell
.\eval\rag\runbeir.ps1 .\eval\datasets\BEIR\scifact
# 可选参数，也可使用 -TopK 10 -Split test
.\eval\rag\runbeir.ps1 .\eval\datasets\BEIR\nfcorpus 10 test
```


**Git Bash 中调用同一 PowerShell 入口**：

```bash
cd /path/to/BatMem
powershell.exe -NoProfile -File eval/rag/runbeir.ps1 eval/datasets/BEIR/scifact
# 可选参数依次为 top-k 和 split
powershell.exe -NoProfile -File eval/rag/runbeir.ps1 eval/datasets/BEIR/nfcorpus 10 test
```

脚本依次执行检索、评分和中文指标展示。输出目录自动命名为 `eval/rag/runs/<数据集目录名>--<编号>`，例如 `scifact--1`、`scifact--2`。编号取已有同名结果目录中最大的数字加一；没有历史结果时从 1 开始，失败运行留下的目录也会占用编号。路径包含空格时用引号包裹。默认 top-k 为 10、split 为 test，评分位置为 1、5（top-k 至少为 5 时）以及 top-k，自动去重。

以下命令在 PowerShell 中执行。需要 Node.js 22.19+ 和 Python 3.10+，无需启动 Pi 或配置模型 API Key。

**1. 首次准备 Python 环境**（已有环境可跳过创建，只在依赖变更时重新安装）：

```powershell
python -m venv eval/.venv
.\eval\.venv\Scripts\python.exe -m pip install -r eval/rag/requirements.txt
```

**2. 入库并批量检索**（以仓库中现有 SciFact 数据为例）：

```powershell
node eval/rag/run.ts --dataset eval/datasets/BEIR/scifact --output eval/rag/runs/scifact-001 --top-k 10 --split test
```

`--dataset` 指向直接包含 `corpus.jsonl`、`queries.jsonl` 和 `qrels/` 的目录；`--split test` 选择 `qrels/test.tsv`；`--top-k 10` 导出最多十项检索结果。更换 BEIR 子数据集只需替换数据目录，例如 `eval/datasets/BEIR/nfcorpus`。

**3. 计算指标并显示中文说明**：

```powershell
.\eval\.venv\Scripts\python.exe eval/rag/score_rag.py eval/rag/runs/scifact-001 --k 1 5 10
```

`--k` 指定需要评分的截断位置，不能大于检索阶段的 `--top-k`；省略时只计算导出的最大 K。

评分后会从 `metrics.json` 逐行显示 `指标名: 分数 - 中文含义`，分数保留四位小数，均为逐题平均值，越高越好。例如：

```text
recall@10: 0.7956 - 全部已标注相关文档中，被前 K 项结果找回的比例
mrr@10: 0.6348 - 首个相关结果排名的倒数均值，衡量首次找到相关内容的快慢
```

只查看已有报告，不重新评分：

```powershell
.\eval\.venv\Scripts\python.exe eval/rag/score_rag.py eval/rag/runs/scifact-001 --show-only
```

后续接入其他数据集时，在本节新增对应小节，记录 Loader、数据格式和运行命令。

检索阶段的输出目录必须不存在，父目录会自动创建；再次运行请换用新目录，例如 `eval/rag/runs/scifact-002`。每次实验使用独立 `index.db`，不会覆盖项目的记忆库。评分及查看报告可以重复使用同一个运行目录。

- `retrieval.jsonl`：按生产排名导出所有已标注查询、Top-K ID、原始 BM25 分数、文本和 Qrels；无命中查询保留空结果。
- `manifest.json`：仅在检索全部完成后写入，记录数据和实现源码哈希、Node/SQLite 版本、索引规则及样本数。
- `query_metrics.jsonl`：逐题指标。
- `metrics.json`：逐题指标的宏平均，即每个查询等权。

`ID Precision` 和 `Recall` 使用固定版本 Ragas，无需模型或 API Key。`CP`、`MRR` 和 `nDCG` 按本文公式计算；nDCG 使用 `2^rel - 1` 增益，与采用线性增益的工具结果应区别比较。非正分数视为不相关，未标注文档按零相关性评分。无命中查询指标为零；没有正相关标注的查询也记零并单独计数。ID Precision 分母是实际返回数量，不用空结果补足 K。

离线测试命令：

```powershell
node --test eval/rag/test/eval.test.ts
eval/.venv/Scripts/python.exe -m unittest discover -s eval/rag/test -p test_score_rag.py
```

这些测试使用临时构造的数据校验导入、索引和指标计算；不代表任何真实 BEIR 数据集的评测成绩。

### LongMemEval

**一键运行 Powershell**：

```powershell
.\eval\longmem\runlongmem.ps1 -Limit 3
# 替换模型或数据集；Provider / Model 必须是 Pi 中可用的配置
.\eval\longmem\runlongmem.ps1 -DatasetPath .\eval\datasets\LongMemEval\longmemeval_s_cleaned.json -Provider deepseek -Model deepseek-flash -Limit 5
```

脚本默认使用上述 LongMemEval-S 文件、`deepseek/deepseek-flash`、前 5 道题及 `memory` 模式(加载BatMem记忆插件)，依次展示 `prepare / build / answer / judge` 阶段，最后输出指标。每道题可能包含数十段历史，每段都需要一次摘要调用；题数不等于模型请求数。


输出自动编号为 `eval/longmem/runs/<数据集文件名去扩展名>--<编号>`，失败目录也占用编号。build 缓存默认位于数据集同级的 `builds/<fingerprint>`；指纹包含数据集内容、类型筛选、摘要模型、摘要 Prompt 和eval/BatMem代码哈希。
- Limit从 10 改为 5 可以直接复用前 5 题，扩到 15 时只为新增 5 题准备和建库。存储、Session 转换或摘要输入格式发生不兼容变化时，维护者才递增格式版本。
可用 `-Types multi-session,temporal-reasoning` 筛选题型，`-BuildsDirectory` 更改缓存根目录，`-OutputDirectory` 指定一个尚不存在的运行目录。`-JudgeProvider / -JudgeModel` 可单独指定评分模型，`-TimeoutMs` 设置问答和 Judge 超时，`-Mode no-memory` 运行无记忆对照并跳过摘要建库。任一阶段失败立即停止并保留产物，不自动重试。

build 目录中的 `sampleDirectories` 是可增长状态，不是身份输入。若 prepare 在写入 `samples/<序号>/sample.json` 后中断、但尚未来得及更新 `build-manifest.json`，下一次扩容会重新读取该样本并校验其 `question_id`；匹配则登记并继续。不要手动在不同 build 间复制或移动 `samples/`：其中的 `sample.json` 保存了本机绝对路径，且每个 build 的题目顺序必须与其筛选条件一致。

Git Bash 可调用同一入口：

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File eval/longmem/runlongmem.ps1 -Limit 3
```

**恢复中断的建库**（先确认原评测进程已退出）：

```powershell
.\eval\longmem\runlongmem.ps1 -ResumeDirectory .\eval\longmem\runs\longmemeval_s_cleaned--1
```

恢复入口读取 run 的 `run-manifest.json` 和 build 的 `build-manifest.json`，自动恢复摘要模型和样本列表，无需提供数据集或 Limit，也不重新生成 Session 文件。按原顺序跳过同时拥有匹配 `memory-ready.json` 和 DB 的样本；对于未完成样本，删除该题的 `index.db / index.db-wal / index.db-shm`，从其第一段历史重新建库。完成标记在 DB 关闭后通过临时文件重命名发布，避免中断时留下半写入的标记。摘要用量记录继续追加，包含中断前已发生的调用。

剩余建库完成后，脚本继续问答和评分。摘要模型或摘要 Prompt 变更会得到新的 build 指纹，不会混用已有索引；原始历史文件不删除。此入口针对 build 中断，要求 prepare 已完整生成 run/build manifest；如果 answer 已启动，会停止并保留问答文件，不会覆盖。只恢复建库也可使用下方 `--stage build` 命令指向原 run 目录。

**分阶段运行**（需要重用建库结果或单独评分时）：

以下命令从 BatMem 目录执行。`prepare` 离线生成文件；`build`、`answer`、`judge` 会实际调用配置模型。`--provider`、`--model` 必须对应 Pi 中已有的模型配置，不会静默替换其他模型。

```powershell
# 1. 将这里替换为你在 Pi 中配置的 provider 和模型 ID
$provider = "deepseek"
$model = "替换为实际模型ID"

# 2. 创建运行目录，并在数据集 builds/ 下创建或复用指定摘要模型的缓存
node eval/longmem/run.ts --stage prepare --dataset eval/datasets/LongMemEval/longmemeval_s_cleaned.json --output eval/longmem/runs/lme-001 --limit 5 --types multi-session --provider $provider --model $model

# 3. 为该 build 中每道题的历史 Session 构建摘要与索引
node eval/longmem/run.ts --stage build --output eval/longmem/runs/lme-001 --provider $provider --model $model

# 4. 使用空白 Pi Session 回答，系统 Prompt 由 Pi SDK 自身构造
node eval/longmem/run.ts --stage answer --output eval/longmem/runs/lme-001 --provider $provider --model $model

# 5. 默认用同一模型判分，逐行展示准确率
node eval/longmem/run.ts --stage judge --output eval/longmem/runs/lme-001 --provider $provider --model $model
```

可用 `--judge-provider`、`--judge-model` 单独指定评分模型；`--timeout-ms` 控制单题问答及 Judge 请求超时，默认 120000 毫秒。`--stage all` 会顺序执行准备、摘要、问答和判分，要求新输出目录及数据、模型参数。

当前支持 `memory`（默认：自动摘要注入、摘要搜索及原文读取）和 `no-memory`。无记忆对照复用同一个 run/build 映射，以 `--stage answer --mode no-memory` 执行，再以 `--stage judge --mode no-memory` 评分；它仍以 build 的 `project` 为 Pi cwd，但 Pi 新会话和 Agent 状态写入 run，且不加载 BatMem。Raw Retrieval、Summary-only 对照尚未实现，不将它们冒充为现有模式。

主要产物分为可复用 build 与一次性 run：

```text
eval/datasets/LongMemEval/builds/<fingerprint>/
├── build-manifest.json                # 数据、类型筛选、摘要模型/Prompt、格式版本；代码哈希仅供审计
└── samples/<序号>/
    ├── sample.json                    # 问题、参考答案和 ID 映射；在 Agent cwd 外
    ├── history/*.jsonl                # 导入的历史 Session；在 Agent cwd 外
    ├── memory-ready.json              # 全部历史摘要构建成功后的标记
    ├── summary-usage.jsonl            # 历史摘要调用用量
    └── project/.pi/docs-memory/index.db

eval/longmem/runs/<run-id>/
├── run-manifest.json                  # 引用的 build 目录及指纹
├── answer-config-memory.json          # 问答模型、超时和模式
├── answers-memory.jsonl               # question_id / hypothesis
├── failures-memory.jsonl              # 问答失败时生成
├── judge-results-memory.jsonl         # 逐题判定、评分模型与用量
├── judge-failures-memory.jsonl        # 评分失败时生成
├── metrics-memory.json                # 总体、类型平均、逐类和拒答准确率
└── samples/<序号>/
    ├── answer-memory.json             # 最终文本、Agent 主请求用量和耗时
    ├── trace-memory.jsonl             # 自动注入、工具调用/结果及实际系统 Prompt
    ├── agent/                         # Pi 本轮资源状态
    └── sessions/                      # Pi 本轮新建的 Session JSONL
```

重要文件的流向：

| 文件 | 写入与读取 |
| --- | --- |
| `build-manifest.json` | build 的数据、题型筛选、模型和格式版本；其 SHA-256 指纹决定缓存目录，不包含 run 的 Limit 或 sampleDirectories |
| `run-manifest.json` | run 指向唯一 build；后续 build、answer、judge 从这里定位输入 |
| `sample.json`、`history/*.jsonl` | build 保存标准化样本、原始 ID 映射和历史；build 通过映射加载历史，judge 从 build 读取参考答案 |
| `index.db`、`memory-ready.json` | build 保存原文及摘要，并在该题全部历史建库成功后写标记；answer 临时使用 DB 后恢复快照 |
| `answer-memory.json`、`answers-memory.jsonl` | answer 逐题保存详细结果（文本、用量、耗时）和精简集合（`question_id / hypothesis`）；judge 只读取后者作为实际回答 |
| `trace-memory.jsonl` | 每题结束时写入检索和工具证据，供人工排查，不传给 Judge |
| `judge-results-memory.jsonl`、`metrics-memory.json` | judge 逐题保存判定和原始模型响应；全部成功后汇总指标 |

`summary-usage.jsonl` 只记录摘要请求用量和停止原因，摘要正文位于 DB。`build-manifest.json` 和 `answer-config-*.json` 分别记录建库、问答阶段配置。Pi 回答时 cwd 是 build 的 `project`，但新建的真实 Session 位于 run 的 `samples/*/sessions/`，与 `history/*.jsonl` 的导入历史分开。

无记忆模式的回答、Trace 和评分文件使用 `no-memory` 后缀。单题失败保留记录；回答缺失或重复时禁止进入 Judge，避免缩小分母。问答和评分输出拒绝覆盖，改变回答模型或重跑请使用新的运行目录。重新执行 `build` 会跳过已完成样本；已生成但尚未登记到 build manifest 的样本会在下一次 prepare 扩容时校验并补登记，未完成 SQLite 样本则清库后重新生成全部摘要。

摘要、问答和判分三者可以使用同一个 DeepSeek。历史摘要使用 BatMem Prompt；Agent 回答使用 Pi 系统 Prompt；Judge 使用官方评分 Prompt。Trace 会记录实际系统消息，但不会记录鉴权 headers。运行结束时 BatMem 会按生产行为尝试同步问答 Session；Runner 随后恢复 build 的 DB 快照，因此该额外摘要不会污染缓存，也不计入 `answer-*.json` 的 Agent 主请求用量。

代码测试文件在 `eval/longmem/test/`，仅使用临时文件和 Mock/Faux 模型：

```powershell
node --test eval/longmem/test/*.test.ts
```
