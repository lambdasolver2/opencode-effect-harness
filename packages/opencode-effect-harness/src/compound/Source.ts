/**
 * Source — session acquisition ports plus the bounded digest builder.
 * Two adapters exist: Live (server plugin, event-driven) and Historical
 * (companion full-client). The server context can NEVER enumerate history.
 */
import { Context, Effect, Schema, Stream } from 'effect';

import { Digest as TraceDigest } from './Trace.ts';
import type { SessionEvent } from './Trace.ts';
export type { SessionEvent };

export class Summary extends Schema.Class<Summary>('SessionSummary')({
	sessionID: Schema.String,
	title: Schema.optionalKey(Schema.String),
	directory: Schema.optionalKey(Schema.String),
	updatedAt: Schema.String
}) {}

export class SourceError extends Schema.TaggedError<SourceError>()(
	'SourceError',
	{ reason: Schema.String }
) {}

export namespace Live {
	export interface Service {
		explicit(sessionID: string): Effect.Effect<Summary, SourceError>;
		follow(): Stream.Stream<SessionEvent>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/LiveSessionSource'
	) {}
}

export interface HistoricalPage {
	readonly summaries: ReadonlyArray<Summary>;
	readonly nextCursor?: string | undefined;
}

export namespace Historical {
	export interface Service {
		list(input: {
			readonly scope: 'project' | 'all';
			readonly directory?: string | undefined;
			readonly cursor?: string | undefined;
		}): Effect.Effect<HistoricalPage, SourceError>;
		exportSanitized(sessionID: string): Effect.Effect<
			{ info: Summary; messages: ReadonlyArray<unknown> },
			SourceError
		>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/HistoricalSessionSource'
	) {}
}

/** Build a bounded TraceDigest from raw trace parts. Pure. */
export const buildDigest = (input: {
	taskPrompt: string;
	attemptedStrategy: string;
	steps: ReadonlyArray<string>;
	failure?: string;
	detection?: string;
	correction?: string;
	lesson: string;
	score?: number;
	fullTraceRef?: string;
}): TraceDigest =>
	new TraceDigest({
		taskPrompt: input.taskPrompt,
		attemptedStrategy: input.attemptedStrategy,
		observableSteps: input.steps.slice(0, 20),
		...(input.failure !== undefined ? { failure: input.failure } : {}),
		...(input.detection !== undefined ? { detection: input.detection } : {}),
		...(input.correction !== undefined ? { correction: input.correction } : {}),
		transferableLesson: input.lesson,
		...(input.score !== undefined ? { score: input.score } : {}),
		...(input.fullTraceRef !== undefined ? { fullTraceRef: input.fullTraceRef } : {})
	});
