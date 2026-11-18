import type { DatabaseSync } from "node:sqlite";
import { load } from "sqlite-vec";
import { rowToHit } from "../search/rows.ts";
import type { RetrievalHit } from "../search/types.ts";
import type { EmbeddingProvider } from "./provider.ts";
import type { PendingEmbedding, VectorIndexStatus } from "./types.ts";

const loadedConnections = new WeakSet<DatabaseSync>();

/**
 * Persistent float32 vectors with sqlite-vec cosine retrieval. Uses an exact scan over the source's
 * stored vectors, not ANN. Ordinary tables let text invalidation work even without loading native code.
 * The caller owns the connection; HTTP calls never hold a write transaction.
 */
export class VectorIndex {
	private readonly db: DatabaseSync;
	private readonly provider: EmbeddingProvider;
	private readonly batchSize: number;
	private pendingSync: Promise<void> = Promise.resolve();

	constructor(db: DatabaseSync, provider: EmbeddingProvider, batchSize = 32) {
		if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Embedding batchSize must be positive.");
		if (!Number.isSafeInteger(provider.dimensions) || provider.dimensions < 1 || !provider.identity)
			throw new Error("Invalid embedding configuration.");
		this.db = db;
		this.provider = provider;
		this.batchSize = batchSize;
	}

	/** Initialize one active encoding configuration. Incompatible existing vectors require explicit rebuild(). */
	initialize(): void {
		if (!loadedConnections.has(this.db)) {
			load(this.db);
			loadedConnections.add(this.db);
		}
		this.db
			.prepare("INSERT OR IGNORE INTO embedding_config VALUES (1, ?, ?)")
			.run(this.provider.identity, this.provider.dimensions);
		this.assertConfiguration(this.provider);
	}

	/** Explicitly discard all vectors, preserving text/FTS. Next sync builds with this provider's configuration. */
	rebuild(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.exec("DELETE FROM embeddings; DELETE FROM embedding_config;");
			this.db
				.prepare("INSERT INTO embedding_config VALUES (1, ?, ?)")
				.run(this.provider.identity, this.provider.dimensions);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Backfill missing vectors, including failures from earlier runs and unchanged documents/summaries.
	 * Calls on this instance are serialized. A rejected batch stays pending; no automatic model retry.
	 */
	// 对memory/document部分的数据库进行检查，如有对应内容但没有对应向量记录的就补向量化
	syncEmbeddings(source: RetrievalHit["sourceType"], onProgress?: (status: VectorIndexStatus) => void): Promise<void> {
		const work = this.pendingSync.then(async () => {
			this.initialize();
			// Bound a pass to current units. Concurrent edits stay pending for the next explicit sync.
			const lastId = Number(
				this.db
					.prepare("SELECT coalesce(max(unit_id), 0) AS id FROM retrieval_units WHERE source_type = ?")
					.get(source)!.id,
			);
			let batch = this.loadPendingBatch(source, 0, lastId);
			while (batch.length) {
				const vectors = await this.provider.embedDocuments(batch.map((unit) => unit.text));
				this.saveEmbeddingBatch(source, batch, vectors);
				onProgress?.(this.getStatus(source));
				batch = this.loadPendingBatch(source, batch[batch.length - 1].unitId, lastId);
			}
		});
		// A later explicit sync may recover a failed batch; the current caller still receives the error.
		this.pendingSync = work.catch(() => {});
		return work;
	}

	/** Count complete and pending units in a single snapshot. No model calls. */
	getStatus(source: RetrievalHit["sourceType"]): VectorIndexStatus {
		this.assertConfiguration(this.provider);
		const row = this.db
			.prepare(`SELECT count(*) AS total, count(e.unit_id) AS indexed FROM retrieval_units u
			LEFT JOIN embeddings e ON e.source_type = u.source_type AND e.unit_id = u.unit_id WHERE u.source_type = ?`)
			.get(source)!;
		const total = Number(row.total);
		const indexed = Number(row.indexed);
		return { total, indexed, pending: total - indexed };
	}

	/** Reject incompatible or incomplete indexes before spending tokens on query encoding. */
	assertReady(source: RetrievalHit["sourceType"], provider: EmbeddingProvider): void {
		this.initialize();
		this.assertConfiguration(provider);
		const status = this.getStatus(source);
		if (status.pending)
			throw new Error(`Vector index is incomplete: ${status.pending}/${status.total} ${source} units pending.`);
	}

	/** Return cosine similarity (1 - distance), descending, with the same source coordinates as BM25. */
	search(source: RetrievalHit["sourceType"], vector: readonly number[], topK: number): RetrievalHit[] {
		this.assertReady(source, this.provider);
		if (!Number.isSafeInteger(topK) || topK < 1) return [];
		const blob = this.encodeVector(vector);
		return this.db
			.prepare(`SELECT u.*, 1 - vec_distance_cosine(e.vector, ?) AS score
			FROM embeddings e JOIN retrieval_units u ON u.source_type = e.source_type AND u.unit_id = e.unit_id
			WHERE u.source_type = ? ORDER BY score DESC, u.source_id, u.chunk_index LIMIT ?`)
			.all(blob, source, topK)
			.map(rowToHit);
	}

	private assertConfiguration(provider: EmbeddingProvider): void {
		const config = this.db.prepare("SELECT identity, dimensions FROM embedding_config WHERE id = 1").get();
		if (config?.identity !== provider.identity || Number(config?.dimensions) !== provider.dimensions)
			throw new Error("Embedding configuration differs from the index; explicitly rebuild vectors before use.");
	}

	private loadPendingBatch(source: RetrievalHit["sourceType"], afterId: number, lastId: number): PendingEmbedding[] {
		return this.db
			.prepare(`SELECT u.* FROM retrieval_units u LEFT JOIN embeddings e
			ON e.source_type = u.source_type AND e.unit_id = u.unit_id
			WHERE u.source_type = ? AND u.unit_id > ? AND u.unit_id <= ? AND e.unit_id IS NULL ORDER BY u.unit_id LIMIT ?`)
			.all(source, afterId, lastId, this.batchSize)
			.map((row) => ({ unitId: Number(row.unit_id), sourceId: String(row.source_id), text: String(row.content) }));
	}

	/** Commit validated vectors only if their captured source and exact content are still current. */
	private saveEmbeddingBatch(source: RetrievalHit["sourceType"], batch: PendingEmbedding[], vectors: number[][]): void {
		if (vectors.length !== batch.length) throw new Error("Embedding provider returned an incorrect vector count.");
		const blobs = vectors.map((vector) => this.encodeVector(vector));
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.assertConfiguration(this.provider);
			const insert = this.db.prepare(`INSERT OR IGNORE INTO embeddings(source_type, unit_id, vector)
				SELECT source_type, unit_id, ? FROM retrieval_units
				WHERE source_type = ? AND unit_id = ? AND source_id = ? AND content = ?`);
			for (let i = 0; i < batch.length; i++) {
				const unit = batch[i];
				insert.run(blobs[i], source, unit.unitId, unit.sourceId, unit.text);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Validate at the storage boundary too: mocks and future providers must obey the same contract. */
	private encodeVector(vector: readonly number[]): Uint8Array {
		if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))
			throw new Error("Embedding must contain finite numbers.");
		const floats = new Float32Array(vector);
		if (
			floats.length !== this.provider.dimensions ||
			floats.some((value) => !Number.isFinite(value)) ||
			!floats.some((value) => value !== 0)
		)
			throw new Error("Embedding must be a finite, nonzero float32 vector with the configured dimensions.");
		return new Uint8Array(floats.buffer);
	}
}
