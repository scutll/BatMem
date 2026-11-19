import type { QueryRecall } from "../core/recall.ts";
import type { RecallResult, RecallTask, RetrievalHit, RetrievalQuery } from "../core/types.ts";

/** Concurrent paths with isolated requests, stable result order and fully drained failures. */
export class ParallelRecall<T extends RetrievalHit = RetrievalHit> implements QueryRecall<T> {
	private readonly tasks: readonly RecallTask<T>[];

	constructor(tasks: readonly RecallTask<T>[]) {
		const paths = new Set<string>();
		for (const task of tasks) {
			if (!task.path.trim() || paths.has(task.path))
				throw new Error(`Recall path must be nonempty and unique: ${task.path}`);
			paths.add(task.path);
		}
		this.tasks = tasks.map((task) => ({ ...task }));
	}

	async recall(request: RetrievalQuery): Promise<RecallResult<T>[]> {
		if (!this.tasks.length) throw new Error("No recall paths are configured.");
		const requests = this.tasks.map(() => ({ ...request }));
		const settled = await Promise.allSettled(
			this.tasks.map(async (task, index) => ({ path: task.path, hits: await task.run(requests[index]) })),
		);
		const results: RecallResult<T>[] = [];
		const errors: Error[] = [];
		for (const [index, result] of settled.entries()) {
			if (result.status === "fulfilled") results.push(result.value);
			else
				errors.push(
					new Error(`Recall path ${this.tasks[index].path} failed: ${String(result.reason)}`, {
						cause: result.reason,
					}),
				);
		}
		if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
		return results;
	}
}
