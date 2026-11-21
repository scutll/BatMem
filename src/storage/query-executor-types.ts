import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

export interface SQLiteQuery {
	sql: string;
	parameters?: readonly SQLInputValue[];
	/** Load sqlite-vec on this connection before preparing the statement. */
	vector?: boolean;
}

export type QueryRows = Record<string, SQLOutputValue>[];

export interface QueryExecutor {
	execute(query: SQLiteQuery): Promise<QueryRows>;
	/** Reject new work and drain accepted queries before releasing connections. */
	close(): Promise<void>;
}

export type QueryWorkerRequest = { type: "query"; query: SQLiteQuery } | { type: "close" };
export type QueryWorkerResponse =
	| { type: "ready" }
	| { type: "result"; rows: QueryRows }
	| { type: "error"; error: Error };
