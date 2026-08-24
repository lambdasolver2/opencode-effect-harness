import type { Schema } from 'effect';
import { Context, Effect, Layer } from 'effect';

import { Decision } from './Decision.ts';
import * as Hook from './hook/Hook.ts';
import { HookSet } from './hook/HookSet.ts';
import type { Intent } from './Intent.ts';
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
	Effect.forEach(hooks, (hook) => hook.run(input), { concurrency: 1 }).pipe(
		Effect.map((perHook) => perHook.flatMap((decisions) => [...decisions]))
	);

export interface ToolCallDispatch {
	readonly activeBranch: import('./Branch.ts').Branch.Value;
	readonly cwd: string;
	readonly input: unknown;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly agent?: string | undefined;
	readonly sessionId?: string | undefined;
	readonly writeIntent: IntentValue | undefined;
}

export interface ToolResultDispatch {
	readonly activeBranch: import('./Branch.ts').Branch.Value;
	readonly cwd: string;
	readonly input: unknown;
	readonly isError: boolean;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly agent?: string | undefined;
	readonly writeIntent: IntentValue | undefined;
}

export namespace Controller {
	export interface Interface {
		readonly onSessionStart: (input: {
			readonly cwd: string;
		}) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly onBeforeAgentStart: (input: {
			readonly activeBranch: import('./Branch.ts').Branch.Value;
			readonly cwd: string;
		}) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly onToolCall: (
			input: ToolCallDispatch
		) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly onToolResult: (
			input: ToolResultDispatch
		) => Effect.Effect<ReadonlyArray<DecisionValue>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/Controller'
	) {}

	/** Direct construction for hosts that compose without layers. */
	export const make = (dependencies: {
		readonly hookSet: HookSet.Interface;
		readonly engine: Engine.Interface;
	}): Interface => {
		const onSessionStart: Interface['onSessionStart'] = (input) =>
			Effect.flatMap(hookSetAll(dependencies), (hooks) =>
				runHooks(Hook.sessionStarts(hooks), input)
			);

		const onBeforeAgentStart: Interface['onBeforeAgentStart'] = (input) =>
			Effect.gen(function*() {
				const hooks = yield* hookSetAll(dependencies);
				const hookDecisions = yield* runHooks(
					Hook.beforeAgentStarts(hooks),
					input
				);
				const ruleDecisions = yield* dependencies.engine.evaluateBeforeAgentStart({
					activeBranch: input.activeBranch,
					cwd: input.cwd
				});
				return [...hookDecisions, ...ruleDecisions];
			});

		const onToolCall: Interface['onToolCall'] = (input) =>
			Effect.gen(function*() {
				const hooks = yield* hookSetAll(dependencies);
				const hookDecisions = yield* runHooks(Hook.toolCalls(hooks), {
					activeBranch: input.activeBranch,
					cwd: input.cwd,
					input: input.input,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					...(input.agent !== undefined ? { agent: input.agent } : {}),
					...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
					writeIntent: input.writeIntent
				});
				const ruleDecisions =
					input.writeIntent === undefined
						? emptyDecisions
						: yield* dependencies.engine.evaluateToolCall({
							activeBranch: input.activeBranch,
							cwd: input.cwd,
							...(input.agent !== undefined ? { agent: input.agent } : {}),
							...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
							writeIntent: input.writeIntent
						});
				return [...hookDecisions, ...ruleDecisions];
			});

		const onToolResult: Interface['onToolResult'] = (input) =>
			Effect.gen(function*() {
				const hooks = yield* hookSetAll(dependencies);
				const hookDecisions = yield* runHooks(Hook.toolResults(hooks), {
					activeBranch: input.activeBranch,
					cwd: input.cwd,
					input: input.input,
					isError: input.isError,
					sessionId: input.sessionId,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					...(input.agent !== undefined ? { agent: input.agent } : {}),
					writeIntent: input.writeIntent
				});
				const ruleDecisions =
					input.writeIntent === undefined || input.isError
						? emptyDecisions
						: yield* dependencies.engine.evaluateToolResult({
							activeBranch: input.activeBranch,
							cwd: input.cwd,
							toolName: input.toolName === 'edit' ? 'edit' : 'write',
							writeIntent: input.writeIntent
						});
				return [...hookDecisions, ...ruleDecisions];
			});

		return { onSessionStart, onBeforeAgentStart, onToolCall, onToolResult };
	};

	const hookSetAll = (dependencies: {
		readonly hookSet: HookSet.Interface;
	}) => dependencies.hookSet.all;

	export const layer: Layer.Layer<
		Service,
		never,
		HookSet.Service | Engine.Service
	> = Layer.effect(
		Service,
		Effect.gen(function*() {
			const hookSet = yield* HookSet.Service;
			const engine = yield* Engine.Service;
			return Service.of(make({ hookSet, engine }));
		})
	);
}
