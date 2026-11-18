import type { RecallResult, RecallTask, RetrievalHit, RetrievalQuery } from "./types.ts";

/** Concurrent task scheduling shared by concrete recall combinations. No ranking or fusion. */
export abstract class QueryRecall<T extends RetrievalHit = RetrievalHit> {
	private readonly tasks: RecallTask<T>[] = [];

	protected addTask(task: RecallTask<T>): void {
		if (!task.path.trim() || this.tasks.some((registered) => registered.path === task.path))
			throw new Error(`Recall path must be nonempty and unique: ${task.path}`);
		this.tasks.push({ ...task });
	}

	async recall(request: RetrievalQuery): Promise<RecallResult<T>[]> {
		const tasks = [...this.tasks];
		if (!tasks.length) throw new Error("No recall paths are configured.");
		// Copy before starting tasks: a path may rewrite its request without affecting another path.
		const requests = tasks.map(() => ({ ...request }));
		const settled = await Promise.allSettled(
			tasks.map(async (task, index) => ({ path: task.path, hits: await task.run(requests[index]) })),
		);
		const results: RecallResult<T>[] = [];
		const errors: Error[] = [];
		for (const [index, result] of settled.entries()) {
			if (result.status === "fulfilled") results.push(result.value);
			else
				errors.push(
					new Error(`Recall path ${tasks[index].path} failed: ${String(result.reason)}`, { cause: result.reason }),
				);
		}
		// Drain even failed requests before the caller may close the shared provider or database.
		if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
		return results;
	}
}
