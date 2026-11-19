import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { JinaEmbeddingProvider } from "./embedding/jina.ts";
import { JinaRerankingProvider } from "./reranking/jina.ts";
import type { JinaRerankingOptions } from "./reranking/types.ts";

/**
 * Read BatMem/.env for both Pi and eval, independent of the current project directory.
 * File values override process variables, including empty values. Never mutate the host environment.
 * Missing credentials disable Jina providers; other file errors remain visible to the caller.
 */
function readJinaOptions(): Pick<JinaRerankingOptions, "apiKey" | "proxyUrl"> | undefined {
	let local: NodeJS.Dict<string> = {};
	try {
		local = parseEnv(readFileSync(new URL("../../.env", import.meta.url), "utf8"));
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
	}
	const apiKey = (local.JINA_API_KEY ?? process.env.JINA_API_KEY)?.trim();
	if (!apiKey) return undefined;
	const proxyUrl = (
		local.HTTPS_PROXY ??
		local.HTTP_PROXY ??
		process.env.HTTPS_PROXY ??
		process.env.HTTP_PROXY
	)?.trim();
	return { apiKey, proxyUrl: proxyUrl || undefined };
}

export function createEmbeddingProvider(): JinaEmbeddingProvider | undefined {
	const options = readJinaOptions();
	return options ? new JinaEmbeddingProvider(options) : undefined;
}

export function createRerankingProvider(): JinaRerankingProvider | undefined {
	const options = readJinaOptions();
	return options ? new JinaRerankingProvider(options) : undefined;
}
