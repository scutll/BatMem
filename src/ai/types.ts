/** DeepSeek-compatible non-streaming chat completion settings. */
export interface completionOptions {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	system?: string;
	thinking?: { type: "enabled" | "disabled" };
	reasoning_effort?: "low" | "medium" | "high";
	stream?: false;
	/** Additional attempts after the initial request; defaults to two. */
	maxRetries?: number;
	/** Per-attempt deadline, including reading the response body. */
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
}
