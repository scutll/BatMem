export interface RerankResult {
	/** Zero-based position in the original RetrievalHit array, not the result rank. */
	index: number;
	/** Larger scores rank first; scores are not calibrated across requests. */
	score: number;
}

export interface JinaRerankingOptions {
	apiKey: string;
	model?: "jina-reranker-v3";
	/** Explicit HTTP(S) proxy for Jina only; does not replace Pi's global HTTP dispatcher. */
	proxyUrl?: string;
	/** Injectable transport for offline verification; defaults to an owned undici connection. */
	fetch?: typeof fetch;
}
