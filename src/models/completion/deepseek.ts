import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { completion } from "./completion.ts";
import type { completionOptions } from "./types.ts";

class CompletionRequestError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean, cause?: unknown) {
		super(message, { cause });
		this.retryable = retryable;
	}
}

/** DeepSeek HTTP adapter; credentials and settings are resolved once per instance. */
export class deepseekCompletion extends completion {
	private readonly options: completionOptions;
	private readonly apiKey: string;
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly request: typeof globalThis.fetch;

	constructor(options: completionOptions = {}) {
		super(options.maxRetries);
		this.options = { ...options, thinking: options.thinking ? { ...options.thinking } : undefined };
		let local: NodeJS.Dict<string> = {};
		if (options.apiKey === undefined) {
			try {
				local = parseEnv(readFileSync(new URL("../../../.env", import.meta.url), "utf8"));
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		this.apiKey = (options.apiKey ?? local.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY)?.trim() ?? "";
		if (!this.apiKey) throw new Error("DEEPSEEK_API_KEY is required for completion.");
		this.url = `${(options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`;
		this.timeoutMs = options.timeoutMs ?? 10_000;
		if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 4_294_967_295)
			throw new Error("timeoutMs must be a positive integer no greater than 4294967295.");
		this.request = options.fetch ?? globalThis.fetch;
	}

	protected override shouldRetry(error: unknown): boolean {
		return error instanceof CompletionRequestError && error.retryable;
	}

	async prompt(text: string): Promise<string> {
		let value: unknown;
		try {
			const response = await this.request(this.url, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.options.model ?? "deepseek-flash",
					messages: [
						{ role: "system", content: this.options.system ?? "" },
						{ role: "user", content: text },
					],
					stream: false,
					thinking: this.options.thinking,
					reasoning_effort: this.options.reasoning_effort,
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new CompletionRequestError(
					`DeepSeek completion failed (HTTP ${response.status}).`,
					response.status === 408 || response.status === 429 || response.status >= 500,
				);
			}
			value = await response.json();
		} catch (error) {
			if (error instanceof CompletionRequestError || error instanceof SyntaxError) throw error;
			throw new CompletionRequestError("DeepSeek completion transport failed.", true, error);
		}
		if (!value || typeof value !== "object" || !("choices" in value) || !Array.isArray(value.choices))
			throw new Error("Invalid DeepSeek completion response.");
		const choice: unknown = value.choices[0];
		if (!choice || typeof choice !== "object" || !("message" in choice))
			throw new Error("Invalid DeepSeek completion choice.");
		const message = choice.message;
		if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string")
			throw new Error("Invalid DeepSeek completion content.");
		const result = message.content.trim();
		if (!result) throw new Error("DeepSeek returned empty completion.");
		return result;
	}
}
