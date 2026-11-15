# LongMemEval - 对Agent的长期交互记忆的评估Branchmark

## Abstract

当前的LLM已经集成了许多组件来追踪user-assistant的对话记录并持久化为长期记忆，以便在用户提问的时候能够提供个性化的和准确的回复。LongMemEval推出用于衡量模型五种核心长期记忆能力的branchmark, 五种核心长期记忆(**five core long-term memory abilities**)包括:

- **information extraction** 从历史会话中提取信息
- **multi-session reasoning**  综合多个会话信息进行推理
- **temporal reasoning**   理解事件事件、会话时间的关系
- **knowledge updates**     识别用户的信息更新
- **abstension**       在缺乏历史证据的时候拒绝编造答案

在论文中，作者讲长期记忆设计统一分解为三个阶段 `indexing - retrieval - reading`

基于unified framework, 作者最后提出了一些记忆设计的优化方案，包括对key和value (value + keyphrases)以及reading(CoN Chain of Notes)的改进



## Branchmark

LongMemEval数据集包括500道人工构造的问题，通过项大量历史会话中插入关键证据会话，构造出不同规模的测试历史。

测试数据在测试集`longmemeval_xx.jsonl`中，单个数据包含若干对话历史集合，测试的问题以及答案。

在测试LLM得出最终答案的时候，通过**LLM-as-a-Judge**(解决LLM回答的问题答案可以灵活表达的问题)来判断最终问答的正确性(yes/no)，最后计算测试中的准确性(**Accuracy**)



## A Unified View

作者将现有的长期记忆框架抽象成**一个大型的 key-value 数据库**，并将记忆强化的agent运行过程简化为四个阶段：**(1) indexing** 将历史会话转化成若干key-value **(2) retrieval** 通过query得到若干相关的key-value 结果 **(3) reading** 模型阅读这些检索结果，然后生成回复

更进一步，作者将有长期记忆的agent的工作分为四个**Control Points: **

- **Value** 表示每个会话存储在记忆中的格式和粒度
  - 比如将一整个会话存储起来，或进行压缩梗概，这里面临上下文长度和信息保留之间的权衡取舍。
- **Key** 用于检索的索引和增强
  - 对于大部分系统，可以直接使用Value作为检索key，但效果一般不太理想，因此作者提出通过key expension来增强检索效果，包括 summaries, keyphrases, user facts, timestamps
- **Query** assistant用的查询参数
  - 对于简单查询，上述的Key-Value优化就可以达到高的检索效果，但是对于包含时间偏好的query, 简单的查询效果就不够理想，作者提出的解决方案是使用 `time-aware indexing & query expension strategy`
- **Reading Strategy** 对查询结果的阅读和回应的生成
  - 检索的准确并不确保模型能完全正确地回答问题，通过`Chain-of-Note`和使用结构化的prompt可以进一步提高assistant的阅读能力和回复准确度



## Memory Optimizations

在提出以上概念后，作者给出了记忆功能的相关优化方案：

### Value Decomposition

使用LLM-based method 来对value进行压缩，Value会被压缩成三个部分：**summaries, keyphrases, user facts**,

对于前面两部分，可以使用Zero-shot Prompt, 即不需要提供示例，而user-fact 部分，使用few-shot prompt，提供示例来指导模型提取事实。

特别地，作者在提取user-fact的过程中，将**Session中的Assistant回复全部剔除，即仅从User Messages中提取**，以更精准地提取用户偏好、个人信息等

### Key Expansion

对Key执行跟Value相似的处理，即在Key中也携带概要、关键词和用户事实，可以实现更精准的查询



### Time-Aware Indexing and Query Expansion

对于Indexing Stage，作者建议从历史文本中提取能确定发生时间的事件，包括：明确包含日期/可以通过上下文推断时间的事件记录。

在Retrieval Stage，同样利用LLM解析Query，提取对应的事件区间。将原本只依赖语义相似度的记忆检索扩展成**能够感知事件约束的检索**



### Reading Strategy

Chain-of-Note可以被用于增强模型阅读记忆资料后的理解能力，以更准确地推断出问题答案。模型被显式指导：遍历文档并在生成答案之前从文档中提取证据

```md
I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.

Answer (step by step):
```

在这个简单的prompt中，模型被要求根据相关历史回答问题，并且在回答的时候需要按照 **提取相关信息 - 对相关信息展开思考** 的步骤进行回答
