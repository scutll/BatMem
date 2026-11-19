import type {
	RetrievalDependencies,
	RetrievalHit,
	RetrievalOptions,
	RetrievalQuery,
	RetrievalService,
} from "./types.ts";

/** Execute the caller's strategy without choosing algorithms or allocating provider connections. */
export class SearchService<T extends RetrievalHit = RetrievalHit> implements RetrievalService<T> {
	private readonly dependencies: RetrievalDependencies<T>;

	constructor(dependencies: RetrievalDependencies<T>) {
		this.dependencies = { ...dependencies };
	}

	async retrieve(request: RetrievalQuery, options: RetrievalOptions<T>): Promise<T[]> {
		if (!Number.isSafeInteger(request.topK) || request.topK < 1) return [];
		if (options.requiresEmbedding && !this.dependencies.vector)
			throw new Error(`Strategy ${options.id} requires an embedding provider and vector retriever.`);
		const original = { ...request };
		// Resolve factories before awaiting so strategy changes cannot affect this invocation.
		const recall = options.createRecall(this.dependencies);
		const processor = options.createProcessor(this.dependencies);
		const results = await recall.recall({ ...original });
		return (await processor.process(original, results)).slice(0, original.topK);
	}
}
