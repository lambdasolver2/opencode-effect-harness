/**
 * Trace — sanitized ATIF-compatible trajectories plus bounded solution-trace
 * digests. ATIF schemas stay wire-compatible; the digest is the bounded,
 * transferable summary feeding distillation and evolution.
 */
import { Schema } from 'effect';

export class ToolCall extends Schema.Class<ToolCall>('ToolCall')({
	tool_call_id: Schema.String,
	function_name: Schema.String,
	arguments: Schema.Unknown
}) {}

export class ObservationResult extends Schema.Class<ObservationResult>(
	'ObservationResult'
)({
	source_call_id: Schema.String,
	content: Schema.String
}) {}

export class Observation extends Schema.Class<Observation>('Observation')({
	results: Schema.Array(ObservationResult)
}) {}

export class AtifStep extends Schema.Class<AtifStep>('AtifStep')({
	step_id: Schema.Number,
	timestamp: Schema.String,
	source: Schema.String,
	message: Schema.String,
	model_name: Schema.optionalKey(Schema.String),
	reasoning_content: Schema.optionalKey(Schema.String),
	tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
	observation: Schema.optionalKey(Observation)
}) {}

export class FinalMetrics extends Schema.Class<FinalMetrics>('FinalMetrics')({
	total_prompt_tokens: Schema.optionalKey(Schema.Number),
	total_completion_tokens: Schema.optionalKey(Schema.Number),
	total_steps: Schema.Number
}) {}

export const schemaVersion = Schema.Literals(['ATIF-v1.2', 'ATIF-v1.6'] as const);

export class Trajectory extends Schema.Class<Trajectory>('AtifTrajectory')({
	schema_version: schemaVersion,
	session_id: Schema.String,
	steps: Schema.Array(AtifStep),
	final_metrics: Schema.optionalKey(FinalMetrics)
}) {}

export class Digest extends Schema.Class<Digest>('TraceDigest')({
	taskPrompt: Schema.String,
	attemptedStrategy: Schema.String,
	observableSteps: Schema.Array(Schema.String),
	failure: Schema.optionalKey(Schema.String),
	detection: Schema.optionalKey(Schema.String),
	correction: Schema.optionalKey(Schema.String),
	transferableLesson: Schema.String,
	score: Schema.optionalKey(Schema.Number),
	fullTraceRef: Schema.optionalKey(Schema.String)
}) {}

export class FailureLesson extends Schema.Class<FailureLesson>('FailureLesson')({
	sourceTrace: Schema.String,
	attempt: Schema.String,
	failure: Schema.String,
	detection: Schema.String,
	resolution: Schema.String,
	invariant: Schema.String
}) {}

export class Provenance extends Schema.Class<Provenance>('TraceProvenance')({
	sessionID: Schema.String,
	projectDir: Schema.optionalKey(Schema.String),
	capturedAt: Schema.Number,
	outcome: Schema.Literals([
		'success',
		'failed',
		'interrupted',
		'unknown'
	]),
	errorSignature: Schema.optionalKey(Schema.String)
}) {}

/** SessionTrace = trajectory + provenance. */
export class SessionTrace extends Schema.Class<SessionTrace>('SessionTrace')({
	trajectory: Trajectory,
	provenance: Provenance
}) {}

/**
 * THE neutral session event projection. Adapters convert host-branded events
 * into this value; nothing downstream imports OpenCode event types.
 */
export interface SessionEvent {
	readonly sessionID: string;
	readonly sequence: number | undefined;
	readonly kind:
		| 'text'
		| 'reasoning'
		| 'tool'
		| 'usage'
		| 'execution'
		| 'compaction';
	readonly timestamp: number;
	readonly payload: unknown;
}
