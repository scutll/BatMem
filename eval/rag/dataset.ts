/** One independently judged retrieval unit. Text is ready for indexing; the runner never splits it. */
export interface CorpusRecord {
	id: string;
	text: string;
}

export interface EvaluationQuery {
	id: string;
	text: string;
	/** Keys are corpus IDs. Only positive grades count as relevant; grades are retained for nDCG. */
	qrels: Record<string, number>;
}

/** Dataset adapters own source formats, text preparation and split selection. No database access. */
export interface DatasetLoader {
	/** Description and files used to record experiment provenance. Empty sourceFiles supports in-memory datasets. */
	readonly name: string;
	readonly split: string;
	readonly indexing: string;
	readonly sourceFiles: readonly string[];
	readonly implementationFiles: readonly URL[];
	/** Stream stable, unique IDs and prepared text, without materializing the corpus. */
	readCorpus(): AsyncIterable<CorpusRecord>;
	/** Return the selected queries and their judgments; adapters validate their source format. */
	loadQueries(): Promise<EvaluationQuery[]>;
}
