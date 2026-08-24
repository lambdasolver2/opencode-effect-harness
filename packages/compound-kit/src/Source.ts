/**
 * Source — session acquisition contracts. Two adapters:
 *  - Live: event-driven, server plugin context (no list/export)
 *  - Historical: full @opencode-ai/client in the TUI/CLI collector
 */
import { Effect, Schema, Stream } from 'effect';

import { Digest as TraceDigest } from './Trace.ts';

export class Summary extends Schema.Class<Summary>('SessionSummary')({
	sessionID: Schema.String,
	title: Schema.optionalKey(Schema.String),
	directory: Schema.optionalKey(Schema.String),
	updatedAt: Schema.String
}) {}

export type SessionEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'reasoning'; readonly text: string }
	| { readonly kind: 'tool'; readonly toolName: string; readonly input: unknown; readonly output?: string }
	| { readonly kind: 'usage'; readonly tokensIn: number; readonly tokensOut: number }
	| { readonly kind: 'execution'; readonly outcome: 'success' | 'failed' | 'interrupted' }
	| { readonly kind: 'compaction' };

export namespace Live {
	export interface Service {
		readonly explicit: (sessionID: string) => Effect.Effect<Summary, Error>;
		readonly follow: Stream.Stream<SessionEvent>;
	}
}

export namespace Historical {
	export interface Service {
		readonly list: (
			scope: 'project' | 'all',
			filter?: { readonly directory?: string; readonly since?: string }
		) => Effect.Effect<ReadonlyArray<Summary>, Error>;
		readonly export: (
			id: string
		) => Effect.Effect<{ info: Summary; messages: ReadonlyArray<unknown> }, Error>;
	}
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
