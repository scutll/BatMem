export interface JinaEmbeddingOptions {
	apiKey: string;
	model?: "jina-embeddings-v3";
	dimensions?: number;
	/** Explicit HTTP(S) proxy for Jina only; does not replace Pi's global HTTP dispatcher. */
	proxyUrl?: string;
	/** Injectable transport for offline verification; defaults to an owned undici connection. */
	fetch?: typeof fetch;
}
