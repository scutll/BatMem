"""Score a completed TS retrieval export. ID metrics use Ragas; no model or API key is needed."""
# This evaluation scores retrieval results exported by the TypeScript runner.

import argparse
import asyncio
import json
import math
import os
from importlib.metadata import version
from pathlib import Path

# Disable optional usage telemetry before importing Ragas.
os.environ["RAGAS_DO_NOT_TRACK"] = "true"
from ragas import SingleTurnSample
# 0.4.4 has no collections equivalent for ID metrics. Use its implementation modules;
# these version-specific imports are covered by the pinned requirement and offline tests.
from ragas.metrics._context_precision import IDBasedContextPrecision
from ragas.metrics._context_recall import IDBasedContextRecall


def ranking_metrics(ids: list[str], qrels: dict[str, int]) -> dict[str, float]:
    """Compute Eval.md CP, reciprocal rank and exponential-gain DCG for a truncated ranking.

    Nonpositive and unjudged grades have zero gain. No retrieved relevant items means CP/RR=0;
    ID recall and normalization by ideal DCG are handled separately by score_results.
    """
    relevant = 0
    precision_sum = 0.0
    reciprocal_rank = 0.0
    dcg = 0.0
    for rank, doc_id in enumerate(ids, 1):
        grade = max(0, qrels.get(doc_id, 0))
        if grade > 0:
            relevant += 1
            precision_sum += relevant / rank
            if not reciprocal_rank:
                reciprocal_rank = 1 / rank
        dcg += (2**grade - 1) / math.log2(rank + 1)
    # score_results uses the requested K: missing hits must not shorten the ideal ranking.
    return {"cp": precision_sum / relevant if relevant else 0.0, "mrr": reciprocal_rank, "dcg": dcg}


async def score_results(run: Path, cutoffs: list[int]) -> dict:
    """Validate completeness, score every query at each K and write per-query and macro means.

    Empty retrieval gets zero precision/recall. Queries without positive qrels are retained as zeros
    and counted explicitly. Failures stop scoring rather than silently reducing the denominator.
    """
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    if manifest["status"] != "complete" or not cutoffs or any(k < 1 or k > manifest["top_k"] for k in cutoffs):
        raise ValueError("Require a completed run and cutoffs between 1 and exported top_k.")
    precision = IDBasedContextPrecision()
    recall = IDBasedContextRecall()
    results = []
    seen = set()
    no_positive = 0
    with (run / "retrieval.jsonl").open(encoding="utf-8") as source:
        for line in source:
            row = json.loads(line)
            query_id = row["query_id"]
            hits = row["hits"]
            ids = [hit["document_id"] for hit in hits]
            if query_id in seen or len(ids) != len(set(ids)) or len(ids) > manifest["top_k"]:
                raise ValueError("Duplicate query/document IDs or too many hits.")
            if row["top_k"] != manifest["top_k"] or [hit["rank"] for hit in hits] != list(range(1, len(hits) + 1)):
                raise ValueError("Invalid exported rank or top_k.")
            seen.add(query_id)
            qrels = row["qrels"]
            references = [doc_id for doc_id, grade in qrels.items() if grade > 0]
            no_positive += not references
            scores = {}
            for k in sorted(set(cutoffs)):
                selected = ids[:k]
                sample = SingleTurnSample(retrieved_context_ids=selected, reference_context_ids=references)
                scores[f"id_precision@{k}"] = await precision.single_turn_ascore(sample) if selected else 0.0
                scores[f"recall@{k}"] = await recall.single_turn_ascore(sample) if references else 0.0
                ranking = ranking_metrics(selected, qrels)
                ideal = sorted((max(0, grade) for grade in qrels.values()), reverse=True)[:k]
                idcg = sum((2**grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(ideal, 1))
                scores[f"cp@{k}"] = ranking["cp"]
                scores[f"mrr@{k}"] = ranking["mrr"]
                scores[f"ndcg@{k}"] = ranking["dcg"] / idcg if idcg else 0.0
            results.append({"query_id": query_id, "metrics": scores})
    if not results or len(results) != manifest["query_count"]:
        raise ValueError("Export count does not match manifest.")
    report = {
        "query_count": len(results), "queries_without_positive_qrels": no_positive,
        "ragas_version": version("ragas"), "ndcg_gain": "2^rel - 1",
        "metrics": {name: sum(row["metrics"][name] for row in results) / len(results) for name in results[0]["metrics"]},
    }
    (run / "query_metrics.jsonl").write_text("".join(json.dumps(row) + "\n" for row in results), encoding="utf-8")
    (run / "metrics.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    return report


def display_metrics(path: Path) -> None:
    """Read the persisted report and explain each aggregate metric without rerunning retrieval or scoring."""
    report = json.loads(path.read_text(encoding="utf-8"))
    descriptions = {
        "id_precision": "前 K 项实际返回结果中，相关文档所占的比例",
        "recall": "全部已标注相关文档中，被前 K 项结果找回的比例",
        "cp": "相关结果所在位置的精确率均值，衡量相关内容是否排在前面",
        "mrr": "首个相关结果排名的倒数均值，衡量首次找到相关内容的快慢",
        "ndcg": "综合相关性等级与排名折损的归一化得分，衡量排序质量",
    }
    print(f"查询数: {report['query_count']}；以下为逐题平均得分，越高越好。")
    for name, score in report["metrics"].items():
        description = descriptions.get(name.split("@", 1)[0], "未定义的指标")
        print(f"{name}: {score:.4f} - {description}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="Directory produced by eval/rag/run.ts")
    parser.add_argument("--k", type=int, nargs="+", default=None)
    parser.add_argument("--show-only", action="store_true", help="Display existing metrics.json without scoring")
    args = parser.parse_args()
    if args.show_only and args.k:
        parser.error("--show-only reads existing scores and cannot be combined with --k")
    if not args.show_only:
        cutoffs = args.k or [json.loads((args.run / "manifest.json").read_text(encoding="utf-8"))["top_k"]]
        asyncio.run(score_results(args.run, cutoffs))
    display_metrics(args.run / "metrics.json")
