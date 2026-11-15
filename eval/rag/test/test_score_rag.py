"""Offline metric checks against hand-computed rankings, including real Ragas ID metrics."""

import asyncio
import json
import math
import tempfile
import unittest
from pathlib import Path

from eval.rag.score_rag import score_results


class RetrievalMetricsTest(unittest.TestCase):
    def test_short_ranking_uses_full_ideal_and_counts_no_positive_queries(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "manifest.json").write_text(json.dumps({"status": "complete", "query_count": 2, "top_k": 3}))
            rows = [
                {"query_id": "short", "top_k": 3, "hits": [{"document_id": "a", "rank": 1}], "qrels": {"a": 1, "b": 1}},
                {"query_id": "zero", "top_k": 3, "hits": [], "qrels": {"a": 0}},
            ]
            (run / "retrieval.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
            report = asyncio.run(score_results(run, [3]))
            self.assertEqual(report["queries_without_positive_qrels"], 1)
            self.assertAlmostEqual(report["metrics"]["recall@3"], 0.25)
            self.assertAlmostEqual(report["metrics"]["ndcg@3"], 1 / (1 + 1 / math.log2(3)) / 2)

    def test_ranked_graded_and_empty_results(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / "manifest.json").write_text(json.dumps({"status": "complete", "query_count": 2, "top_k": 3}))
            rows = [
                {"query_id": "q1", "top_k": 3, "hits": [
                    {"document_id": doc, "rank": rank} for rank, doc in enumerate(["noise", "a", "b"], 1)
                ], "qrels": {"a": 1, "b": 2, "c": 1}},
                {"query_id": "q2", "top_k": 3, "hits": [], "qrels": {"a": 1}},
            ]
            (run / "retrieval.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
            report = asyncio.run(score_results(run, [1, 3]))
            scores = report["metrics"]
            self.assertAlmostEqual(scores["recall@3"], 1 / 3)
            self.assertAlmostEqual(scores["id_precision@3"], 1 / 3)
            self.assertAlmostEqual(scores["cp@3"], (1 / 2 + 2 / 3) / 4)
            self.assertAlmostEqual(scores["mrr@3"], 1 / 4)
            ideal = 3 + 1 / math.log2(3) + 1 / math.log2(4)
            actual = 1 / math.log2(3) + 3 / math.log2(4)
            self.assertAlmostEqual(scores["ndcg@3"], actual / ideal / 2)
            self.assertEqual(scores["recall@1"], 0)
            with self.assertRaises(ValueError):
                asyncio.run(score_results(run, [4]))
            (run / "manifest.json").write_text(json.dumps({"status": "complete", "query_count": 3, "top_k": 3}))
            with self.assertRaises(ValueError):
                asyncio.run(score_results(run, [3]))


if __name__ == "__main__":
    unittest.main()
