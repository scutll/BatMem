import { parseArgs } from "node:util";
import { BeirDataset } from "./beir.ts";
import { runRetrievalEval } from "./runner.ts";

// The composition entry point selects a concrete dataset adapter; runner.ts only knows DatasetLoader.
const { values } = parseArgs({
	options: {
		dataset: { type: "string" },
		output: { type: "string" },
		split: { type: "string", default: "test" },
		"top-k": { type: "string", default: "10" },
	},
});
if (!values.dataset || !values.output) {
	throw new Error(
		"Usage: node eval/rag/run.ts --dataset <BEIR directory> --output <new directory> [--top-k 10] [--split test]",
	);
}
await runRetrievalEval({
	loader: new BeirDataset(values.dataset, values.split),
	output: values.output,
	topK: Number(values["top-k"]),
});
