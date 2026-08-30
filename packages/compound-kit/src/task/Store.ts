/**
 * TaskStore — the persistence PORT for benchmark mode (spec 06 §3).
 *
 * The port is host-neutral: adapters (SQLite today, others later) implement
 * it. Contracts enforced BY THE TYPES:
 *  - single-entity getters return `Option` — "not found" is a value, never
 *    an `undefined` check at call sites;
 *  - trials follow a pending→terminal STATE MACHINE: `createTrials` inserts
 *    pending rows (crash-resumable), `completeTrial` is the ONLY transition
 *    to a terminal status and is rejected (Option.none) once completed;
 *  - `completeJob` is the atomic terminal transition (job status + leading
 *    solution + history event in ONE transaction); leading solutions are
 *    INSERT-only;
 *  - the history hash chain is OWNED BY THE ADAPTER (callers never supply
 *    hashes) and adapters MUST verify it on read;
 *  - `*Json` payload fields are already-encoded strings produced by Schema
 *    codecs at the CALLER.
 */
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ModelProfile, Task, TaskError, TaskSpec } from '../Task.ts';

export interface Page<Value> {
	readonly items: ReadonlyArray<Value>;
	readonly nextCursor: Option.Option<string>;
}

export interface UpsertTaskInput {
	readonly spec: TaskSpec;
	readonly revision: string;
	readonly now: number;
}

export interface CreateJobInput {
	readonly jobId: string;
	readonly taskId: string;
	readonly taskRevision: string;
	readonly blueprintId?: string | undefined;
	readonly blueprintHash?: string | undefined;
	readonly evaluatorId: string;
	readonly rubricHash: string;
	readonly now: number;
}

export interface ScoreInput {
	readonly scoreId: string;
	readonly trialId: string;
	readonly evaluatorId: string;
	readonly rubricHash: string;
	readonly deterministicJson: string;
	readonly dimensionsJson: string;
	readonly total: number;
	readonly now: number;
}

export interface HistoryInput {
	readonly jobId: string;
	readonly kind: string;
	readonly payloadJson: string;
	readonly now: number;
}

export namespace TaskStore {
	export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

	export type PendingStatus = 'pending';

	export type TerminalTrialStatus =
		| 'scored'
		| 'contract-invalid'
		| 'llm-error'
		| 'timeout'
		| 'interrupted'
		| 'judge-unavailable';

	export type TrialStatus = PendingStatus | TerminalTrialStatus;

	/** Terminal trial outcome: everything recorded when a trial finishes. */
	export interface TrialOutcome {
		readonly trialId: string;
		readonly status: TerminalTrialStatus;
		readonly outputText?: string | undefined;
		readonly outputBytes?: number | undefined;
		readonly outputHash?: string | undefined;
		readonly durationMs?: number | undefined;
		readonly tokensIn?: number | undefined;
		readonly tokensOut?: number | undefined;
		readonly sessionId?: string | undefined;
		readonly errorReason?: string | undefined;
		readonly finishedAtMs: number;
		/** Score is stored atomically WITH the terminal outcome when present. */
		readonly score?: Omit<ScoreInput, 'trialId'> | undefined;
	}

	export class JobRecord extends Schema.Class<JobRecord>('BenchmarkJob')({
		jobId: Schema.String,
		taskId: Schema.String,
		taskRevision: Schema.String,
		blueprintId: Schema.optionalKey(Schema.String),
		blueprintHash: Schema.optionalKey(Schema.String),
		evaluatorId: Schema.String,
		rubricHash: Schema.String,
		createdAtMs: Schema.Number,
		status: Schema.Literals(['running', 'completed', 'failed', 'cancelled'])
	}) {}

	export class TrialRecord extends Schema.Class<TrialRecord>('BenchmarkTrial')({
		trialId: Schema.String,
		jobId: Schema.String,
		blueprintId: Schema.String,
		blueprintHash: Schema.String,
		taskId: Schema.String,
		taskRevision: Schema.String,
		profileId: Schema.String,
		provider: Schema.String,
		model: Schema.String,
		variant: Schema.optionalKey(Schema.String),
		trial: Schema.Number,
		status: Schema.Literals([
			'pending', 'running', 'scored', 'contract-invalid',
			'llm-error', 'timeout', 'interrupted', 'judge-unavailable'
		]),
		outputText: Schema.optionalKey(Schema.String),
		outputBytes: Schema.optionalKey(Schema.Number),
		outputHash: Schema.optionalKey(Schema.String),
		durationMs: Schema.optionalKey(Schema.Number),
		tokensIn: Schema.optionalKey(Schema.Number),
		tokensOut: Schema.optionalKey(Schema.Number),
		sessionId: Schema.optionalKey(Schema.String),
		errorReason: Schema.optionalKey(Schema.String),
		startedAtMs: Schema.optionalKey(Schema.Number),
		finishedAtMs: Schema.optionalKey(Schema.Number)
	}) {}

	export class ScoreRecord extends Schema.Class<ScoreRecord>('BenchmarkScore')({
		scoreId: Schema.String,
		trialId: Schema.String,
		evaluatorId: Schema.String,
		rubricHash: Schema.String,
		deterministicJson: Schema.String,
		dimensionsJson: Schema.String,
		total: Schema.Number,
		scoredAtMs: Schema.Number
	}) {}

	export class LeadingRecord extends Schema.Class<LeadingRecord>('BenchmarkLeading')({
		jobId: Schema.String,
		trialId: Schema.String,
		total: Schema.Number,
		selectedAtMs: Schema.Number
	}) {}

	export class HistoryRecord extends Schema.Class<HistoryRecord>('BenchmarkHistory')({
		eventId: Schema.Number,
		jobId: Schema.String,
		sequence: Schema.Number,
		kind: Schema.String,
		payloadJson: Schema.String,
		previousHash: Schema.String,
		hash: Schema.String,
		createdAtMs: Schema.Number
	}) {}

	export class TraceRecord extends Schema.Class<TraceRecord>('BenchmarkTrace')({
		trialId: Schema.String,
		sequence: Schema.Number,
		kind: Schema.String,
		payloadJson: Schema.String,
		previousHash: Schema.String,
		hash: Schema.String,
		createdAtMs: Schema.Number
	}) {}

	export interface CompleteJobInput {
		readonly jobId: string;
		readonly status: Exclude<JobStatus, 'running'>;
		readonly leading?: { readonly trialId: string; readonly total: number } | undefined;
		readonly history: { readonly kind: string; readonly payloadJson: string };
		readonly now: number;
	}

	export interface Service {
		upsertTask(input: UpsertTaskInput): Effect.Effect<Task, TaskError>;
		getTask(taskId: string): Effect.Effect<Option.Option<Task>, TaskError>;
		listTasks(cursor?: string | undefined): Effect.Effect<Page<Task>, TaskError>;

		upsertProfile(profile: ModelProfile): Effect.Effect<void, TaskError>;
		listProfiles(): Effect.Effect<ReadonlyArray<ModelProfile>, TaskError>;
		getProfile(profileId: string): Effect.Effect<Option.Option<ModelProfile>, TaskError>;

		createJob(input: CreateJobInput): Effect.Effect<JobRecord, TaskError>;
		getJob(jobId: string): Effect.Effect<Option.Option<JobRecord>, TaskError>;

		/** Batch-insert PENDING trial rows at job creation (crash-resumable). */
		createTrials(trials: ReadonlyArray<TrialRecord>): Effect.Effect<void, TaskError>;
		/** pending→terminal transition; Option.none means already-terminal. */
		completeTrial(
			outcome: TrialOutcome
		): Effect.Effect<Option.Option<TrialRecord>, TaskError>;
		listTrials(jobId: string): Effect.Effect<ReadonlyArray<TrialRecord>, TaskError>;
		/** Internal job-finalization view; caller has already bounded the job. */
		listAllTrials(jobId: string): Effect.Effect<ReadonlyArray<TrialRecord>, TaskError>;

		listScores(jobId: string): Effect.Effect<ReadonlyArray<ScoreRecord>, TaskError>;
		/** Internal leader-selection view; must not be capped at the UI limit. */
		listAllScores(jobId: string): Effect.Effect<ReadonlyArray<ScoreRecord>, TaskError>;

		/** Atomic terminal transition: job status + leading + history. */
		completeJob(input: CompleteJobInput): Effect.Effect<void, TaskError>;
		getLeading(jobId: string): Effect.Effect<Option.Option<LeadingRecord>, TaskError>;

		appendHistory(input: HistoryInput): Effect.Effect<HistoryRecord, TaskError>;
		/** Verifies the hash chain; a mismatch is a typed error, never silent. */
		listHistory(jobId: string): Effect.Effect<ReadonlyArray<HistoryRecord>, TaskError>;

		recordTrace(input: {
			readonly trialId: string;
			readonly kind: string;
			readonly payloadJson: string;
			readonly now: number;
		}): Effect.Effect<TraceRecord, TaskError>;
		listTrace(trialId: string): Effect.Effect<ReadonlyArray<TraceRecord>, TaskError>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/benchmark/TaskStore'
	) {}

	/** Adapt an already-constructed implementation into the layer. */
	export const layerFrom = (impl: Service): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(impl));
}
