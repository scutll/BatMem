/** Single-turn text completion with bounded retries. */
export abstract class completion {
	private readonly maxRetries: number;

	constructor(maxRetries = 2) {
		if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
			throw new Error("maxRetries must be a nonnegative safe integer.");
		this.maxRetries = maxRetries;
	}

	async getResponse(text: string): Promise<string> {
		for (let attempt = 0; ; attempt++) {
			try {
				const result = (await this.prompt(text)).trim();
				if (!result) throw new Error("Completion returned empty content.");
				return result;
			} catch (error) {
				if (attempt >= this.maxRetries || !this.shouldRetry(error)) throw error;
			}
		}
	}

	protected shouldRetry(_error: unknown): boolean {
		return false;
	}

	abstract prompt(text: string): Promise<string>;
}
