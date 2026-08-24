/**
 * Hook — a host-neutral lifecycle observer. Hooks run before rules and may
 * never block; they return decisions (usually entries/telemetry).
 */
import { Effect, Schema } from 'effect';

import type { Branch } from '../Branch.ts';
import type { Decision } from '../Decision.ts';
import type { Intent } from '../Intent.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type Intent = Schema.Schema.Type<typeof Intent.Value>;

export interface SessionStartInput {
	readonly cwd: string;
}

export interface BeforeAgentStartInput {
	readonly activeBranch: Branch.Value;
	readonly cwd: string;
}

export interface ToolCallInput {
	readonly activeBranch: Branch.Value;
	readonly cwd: string;
	readonly input: unknown;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly writeIntent: Intent | undefined;
}

export interface ToolResultInput {
	readonly activeBranch: Branch.Value;
	readonly cwd: string;
	readonly input: unknown;
	readonly isError: boolean;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly writeIntent: Intent | undefined;
}

export interface OnSessionStart {
	readonly id: string;
	readonly phase: 'sessionStart';
	readonly run: (input: SessionStartInput) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export interface OnBeforeAgentStart {
	readonly id: string;
	readonly phase: 'beforeAgentStart';
	readonly run: (
		input: BeforeAgentStartInput
	) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export interface OnToolCall {
	readonly id: string;
	readonly phase: 'toolCall';
	readonly run: (input: ToolCallInput) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export interface OnToolResult {
	readonly id: string;
	readonly phase: 'toolResult';
	readonly run: (input: ToolResultInput) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export type Any =
	| OnSessionStart
	| OnBeforeAgentStart
	| OnToolCall
	| OnToolResult;

export const sessionStarts = (hooks: ReadonlyArray<Any>): ReadonlyArray<OnSessionStart> =>
		hooks.flatMap((hook) => hook.phase === 'sessionStart' ? [hook] : []);

export const beforeAgentStarts = (hooks: ReadonlyArray<Any>): ReadonlyArray<OnBeforeAgentStart> =>
		hooks.flatMap((hook) => hook.phase === 'beforeAgentStart' ? [hook] : []);

export const toolCalls = (hooks: ReadonlyArray<Any>): ReadonlyArray<OnToolCall> =>
		hooks.flatMap((hook) => hook.phase === 'toolCall' ? [hook] : []);

export const toolResults = (hooks: ReadonlyArray<Any>): ReadonlyArray<OnToolResult> =>
		hooks.flatMap((hook) => hook.phase === 'toolResult' ? [hook] : []);
