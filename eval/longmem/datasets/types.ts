/** Historical text only. Dataset evidence labels are never copied into these messages. */
export interface HistoryMessage {
	role: "user" | "assistant";
	content: string;
}

export interface HistorySession {
	id: string;
	date: string;
	messages: HistoryMessage[];
}

/** References remain outside the Agent working directory and are used only after answering. */
export interface MemorySample {
	id: string;
	question: string;
	date: string;
	type: string;
	abstention: boolean;
	histories: HistorySession[];
	reference: { answer: string; sessionIds: string[] };
}

/** Adapter contract is independent of LongMemEval field names and storage format. */
export interface MemoryDatasetLoader {
	readonly sourcePath: string;
	readSamples(): AsyncIterable<MemorySample>;
}
