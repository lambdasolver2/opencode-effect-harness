/**
 * Controller tests: hooks run before rules; rules are skipped when
 * writeIntent is undefined (non-write tools) and on error tool results.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';

import { Branch } from '../src/Branch.ts';
import { Decision } from '../src/Decision.ts';
import { Intent } from '../src/Intent.ts';
import type * as Hook from '../src/harness/Hook.ts';
import type * as RuleModule from '../src/harness/Rule.ts';
import { Controller as Controller } from '../src/kernel/services/Controller.ts';
import { HookSet } from '../src/kernel/services/HookSet.ts';
import { Engine } from '../src/kernel/services/Engine.ts';
import { RuleSet } from '../src/kernel/services/RuleSet.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;

const emptyBranch = new Branch.Value({ entries: [] });
const intent = new Intent.WriteFile({
	phase: 'before',
	filePath: 'src/x.ts',
	content: 'x'
});

let order: Array<string> = [];

const hookLayer = HookSet.of([
	{
		id: 'hook-first',
		phase: 'toolCall',
		run: () =>
			Effect.sync(() => {
				order.push('hook');
				return [] as ReadonlyArray<DecisionValue>;
			})
	} satisfies Hook.OnToolCall
]);

const ruleLayer = RuleSet.of([
	{
		id: 'rule-second',
		phase: 'toolCall',
		evaluate: () =>
			Effect.sync(() => {
				order.push('rule');
				return [
					new Decision.BlockToolCall({ reason: 'blocked' })
				] as ReadonlyArray<DecisionValue>;
			})
	} satisfies RuleModule.ToolCall
]);

const controllerLayer = Controller.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(hookLayer, ruleLayer, Engine.layer)
	)
);

const runToolCall = (writeIntent: Intent.WriteFile | undefined) =>
	Effect.provide(
		Controller.Service.use((controller) =>
			controller.onToolCall({
				activeBranch: emptyBranch,
				cwd: '/project',
				input: {},
				toolCallId: 'call-1',
				toolName: 'write',
				writeIntent
			})
		),
		Layer.provideMerge(
			Controller.layer,
			Layer.mergeAll(hookLayer, ruleLayer, Engine.layer.pipe(Layer.provide(ruleLayer)))
		)
	);

describe('Controller', () => {
	it.live('runs hooks before rules for tool calls', () =>
		Effect.gen(function*() {
			order = [];
			const decisions = yield* runToolCall(intent);
			expect(order).toEqual(['hook', 'rule']);
			expect(decisions).toHaveLength(1);
			expect(decisions[0]?._tag).toBe('BlockToolCall');
		}));

	it.live('skips rules when writeIntent is undefined', () =>
		Effect.gen(function*() {
			order = [];
			const decisions = yield* runToolCall(undefined);
			expect(order).toEqual(['hook']);
			expect(decisions).toEqual([]);
		}));
});
