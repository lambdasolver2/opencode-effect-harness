import { Context, Effect, Layer, Schema } from 'effect';

import type { Branch } from '../../Branch.ts';
import { Decision } from '../../Decision.ts';
import type { Intent } from '../../Intent.ts';
import * as Hook from '../../harness/Hook.ts';
import { HookSet } from './HookSet.ts';
import { Engine } from './Engine.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

const emptyDecisions: ReadonlyArray<DecisionValue> = [];

const runHooks = <Input>(
	hooks: ReadonlyArray<{
		readonly id: string;
		readonly run: (input: Input) => Effect.Effect<ReadonlyArray<DecisionValue>>;
	}>,
	input: Input
): Effect.Effect<ReadonlyArray<DecisionValue>> =>
	Effect.forEach(hooks, (hook) => hook.run(input)).pipe(
		Effect.map((decisionsPerHook) =>
			decisionsPerHook.flatMap((decisions) => decisions)
		)
	);

export namespace Controller {
	export interface Interface {
		readonly onSessionStart: (input: {
			readonly cwd: string;
		}) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly onBeforeAgentStart: (input: {
			readonly activeBranch: Branch.Value;
			readonly cwd: string;
		}) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly onToolCall: (input: {
			readonly activeBranch: Branch.Value;
			readonly cwd: string;
			readonly input: unknown;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly writeIntent: IntentValue | undefined;
		}) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly onToolResult: (input: {
			readonly activeBranch: Branch.Value;
			readonly cwd: string;
			readonly input: unknown;
			readonly isError: boolean;
			readonly sessionId: string;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly writeIntent: IntentValue | undefined;
		}) => Effect.Effect<ReadonlyArray<DecisionValue>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/kernel/HarnessController'
	) {}

	export const layer = Layer.effect(
		Service,
		Effect.gen(function*() {
			const hookSet = yield* HookSet.Service;
			const ruleEngine = yield* Engine.Service;

			const onSessionStart: Interface['onSessionStart'] = (input) =>
				Effect.flatMap(
					hookSet.all,
					(hooks) => runHooks(Hook.sessionStarts(hooks), input)
				);

			const onBeforeAgentStart: Interface['onBeforeAgentStart'] = (
				input
			) => Effect.gen(function*() {
				const hooks = yield* hookSet.all;
				const hookDecisions = yield* runHooks(
					Hook.beforeAgentStarts(hooks),
					input
				);
				const ruleDecisions = yield* ruleEngine.evaluateBeforeAgentStart({
					activeBranch: input.activeBranch,
					cwd: input.cwd
				});
				return [...hookDecisions, ...ruleDecisions];
			});

			const onToolCall: Interface['onToolCall'] = (input) =>
				Effect.gen(function*() {
					const hooks = yield* hookSet.all;
					const hookDecisions = yield* runHooks(Hook.toolCalls(hooks), input);
					const ruleDecisions = input.writeIntent === undefined
						? emptyDecisions
						: yield* ruleEngine.evaluateToolCall({
							activeBranch: input.activeBranch,
							cwd: input.cwd,
							writeIntent: input.writeIntent
						});
					return [...hookDecisions, ...ruleDecisions];
				});

			const onToolResult: Interface['onToolResult'] = (input) =>
				Effect.gen(function*() {
					const hooks = yield* hookSet.all;
					const hookDecisions = yield* runHooks(
						Hook.toolResults(hooks),
						input
					);
					const ruleDecisions =
						input.writeIntent === undefined || input.isError
							? emptyDecisions
							: yield* ruleEngine.evaluateToolResult({
								activeBranch: input.activeBranch,
								cwd: input.cwd,
								toolName: input.toolName === 'edit' ? 'edit' : 'write',
								writeIntent: input.writeIntent
							});
					return [...hookDecisions, ...ruleDecisions];
				});

			return Service.of({
				onSessionStart,
				onBeforeAgentStart,
				onToolCall,
				onToolResult
			});
		})
	);
}
