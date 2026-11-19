/** Encode retrieval text. Return document vectors in input order and reject an entire failed request. */
export interface EmbeddingProvider {
	/** Stable model/encoding identity, excluding credentials and transport settings. */
	readonly identity: string;
	readonly dimensions: number;
	embedDocuments(texts: readonly string[]): Promise<number[][]>;
	embedQuery(text: string): Promise<number[]>;
}
