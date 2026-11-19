import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createEmbeddingProvider, createRerankingProvider } from "../../src/config.ts";
import { isSearchMode } from "../../src/search/modes.ts";
import { selectRetrievalOptions } from "../../src/search/strategies.ts";
import { BeirDataset } from "./beir.ts";
import { runRetrievalEval } from "./runner.ts";

// The composition entry point selects a concrete dataset adapter; runner.ts only knows DatasetLoader.
const { values } = parseArgs({
	options: {
		dataset: { type: "string" },
		output: { type: "string" },
		split: { type: "string", default: "test" },
		"top-k": { type: "string", default: "10" },
		mode: { type: "string", default: "search" },
		builds: { type: "string", default: fileURLToPath(new URL("./builds/", import.meta.url)) },
	},
});
if (!values.dataset || !values.output) {
	throw new Error(
		"Usage: node eval/rag/run.ts --dataset <BEIR directory> --output <new directory> [--top-k 10] [--split test] [--mode search|vsearch|query] [--builds <cache root>]",
	);
}
if (!isSearchMode(values.mode)) throw new Error(`Mode ${values.mode} doesn't Exist.`);
const retrieval = selectRetrievalOptions(values.mode);
const embedding = retrieval.requiresEmbedding ? createEmbeddingProvider() : undefined;
const reranking = createRerankingProvider();
try {
	await runRetrievalEval({
		loader: new BeirDataset(values.dataset, values.split),
		output: values.output,
		builds: values.builds,
		topK: Number(values["top-k"]),
		retrieval,
		embedding,
		reranking,
	});
} finally {
	await embedding?.close();
	await reranking?.close();
}
