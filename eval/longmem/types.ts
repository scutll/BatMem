import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MemorySample } from "./dataset.ts";

export interface ImportedSession {
	originalId: string;
	sessionId: string;
	path: string;
	messageCount: number;
	sha256: string;
}

export interface TraceEvent {
	type: string;
	data: unknown;
}

export interface QuestionResult {
	text: string;
	usage: AssistantMessage["usage"][];
	elapsedMs: number;
}

/** Keep Pi's newly created session and resource state with one evaluation run, not in the build cache. */
export interface EvaluationSessionStorage {
	agentDirectory: string;
	sessionDirectory: string;
}

export interface JudgePrompts {
	repository: string;
	commit: string;
	source: string;
	sha256: string;
	templates: Record<string, string>;
}

export interface JudgeResponse {
	text: string;
	model: string;
	usage: unknown;
}

export interface Judgment {
	question_id: string;
	question_type: string;
	abstention: boolean;
	label: boolean;
	response: JudgeResponse;
}

export interface PreparedSample {
	sample: MemorySample;
	directory: string;
	project: string;
	sessions: ImportedSession[];
}

/** Inputs that can change indexed summaries or their SQLite representation. */
export interface MemoryBuildConfig {
	model: string;
	summaryPromptSha256: string;
	syncMode: "session-final";
}

/** Limit is applied after optional type filtering and belongs to a run, not a cached build. */
export interface BuildSelection {
	limit: number;
	types: string[];
}

/** Append-only cache description. The fingerprint is independent of a run's limit and cache growth. */
export interface MemoryBuildManifest {
	status: "prepared";
	buildFormat: number;
	fingerprint: string;
	source: string;
	sourceSha256: string;
	selection: { types: string[] };
	buildConfig: MemoryBuildConfig;
	sampleDirectories: string[];
	timeConvention: string;
	codeSha256: Record<string, string>;
}

/** A run points to a build cache and owns its answer artifacts and disposable SQLite copies. */
export interface EvaluationRunManifest {
	status: "prepared";
	buildDirectory: string;
	buildFingerprint: string;
	sampleDirectories: string[];
	retrieval?: string;
	queryPipeline?: { recallPaths: string[]; processor: string };
	codeSha256: Record<string, string>;
	embedding?: { identity: string; dimensions: number };
}

export interface PreparedBuild {
	directory: string;
	manifest: MemoryBuildManifest;
	sampleDirectories: string[];
}

export interface AnswerRequest {
	project: string;
	runtimeDirectory: string;
	question: string;
	date: string;
	trace: TraceEvent[];
}

/** The run owns Pi files and a disposable copy of the indexed project. */
export type AnswerQuestion = (request: AnswerRequest) => Promise<QuestionResult>;
