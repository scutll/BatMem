import type { EmbeddingProvider } from "../embedding/provider.ts";
import type { RetrievalHit, RetrievalQuery, Retriever } from "./types.ts";
import type { VectorIndex } from "../embedding/vector-index.ts";

/** Query encoding and source-scoped vector recall, independent of the concrete HTTP provider. */
export class VectorRetriever implements Retriever {
	private readonly index: VectorIndex;
	private readonly provider: EmbeddingProvider;
	private readonly source: RetrievalHit["sourceType"];

	constructor(index: VectorIndex, provider: EmbeddingProvider, source: RetrievalHit["sourceType"]) {
		this.index = index;
		this.provider = provider;
		this.source = source;
	}

	async retrieve({ query, topK }: RetrievalQuery): Promise<RetrievalHit[]> {
		this.index.assertReady(this.source, this.provider);
		if (!query.trim() || !Number.isSafeInteger(topK) || topK < 1) return [];
		const vector = await this.provider.embedQuery(query);
		// Recheck readiness after HTTP: another session may have changed the corpus in the meantime.
		this.index.assertReady(this.source, this.provider);
		return this.index.search(this.source, vector, topK);
	}
}
