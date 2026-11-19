export interface PendingEmbedding {
	unitId: number;
	sourceId: string;
	text: string;
}

export interface VectorIndexStatus {
	total: number;
	indexed: number;
	pending: number;
}
