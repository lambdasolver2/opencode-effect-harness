/**
 * Rule — a host-neutral policy evaluator. Rules run AFTER hooks and may block
 * writes or inject guidance. Mode gating is composed by each rule factory
 * (an `enabled` effect) so a disabled harness produces empty decisions while
 * hooks keep running.
 */
import type { Branch } from './Branch.ts';
import type { Decision } from './Decision.ts';
import type { Intent } from './Intent.ts';
import type { Schema } from 'effect';
import { Effect } from 'effect';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

export interface BeforeAgentStartInput {
	readonly activeBranch: Branch.Value;
	readonly cwd: string;
}

export interface ToolCallInput {
	readonly activeBranch: Branch.Value;
	readonly cwd: string;
	readonly agent?: string | undefined;
	readonly sessionId?: string | undefined;
	readonly writeIntent: IntentValue;
}

export interface ToolResultInput {
	readonly activeBranch: Branch.Value;
	readonly cwd: string;
	readonly toolName: 'write' | 'edit';
	readonly writeIntent: IntentValue;
}

export interface BeforeAgentStart {
	readonly id: string;
	readonly phase: 'beforeAgentStart';
	readonly evaluate: (
		input: BeforeAgentStartInput
	) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export interface ToolCall {
	readonly id: string;
	readonly phase: 'toolCall';
	readonly evaluate: (
		input: ToolCallInput
	) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export interface ToolResult {
	readonly id: string;
	readonly phase: 'toolResult';
	readonly evaluate: (
		input: ToolResultInput
	) => Effect.Effect<ReadonlyArray<DecisionValue>>;
}

export type Any = BeforeAgentStart | ToolCall | ToolResult;

export const beforeAgentStarts = (
	rules: ReadonlyArray<Any>
): ReadonlyArray<BeforeAgentStart> =>
	rules.flatMap((rule) => (rule.phase === 'beforeAgentStart' ? [rule] : []));

export const toolCalls = (rules: ReadonlyArray<Any>): ReadonlyArray<ToolCall> =>
	rules.flatMap((rule) => (rule.phase === 'toolCall' ? [rule] : []));

export const toolResults = (
	rules: ReadonlyArray<Any>
): ReadonlyArray<ToolResult> =>
	rules.flatMap((rule) => (rule.phase === 'toolResult' ? [rule] : []));
