/**
 * Kernel decision + rule-engine tests: rules run in phase, decisions are
 * concatenated in registration order.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';

import { Branch } from '../src/Branch.ts';
import { Decision } from '../src/Decision.ts';
import type * as RuleModule from '../src/harness/Rule.ts';
import { Engine } from '../src/kernel/services/Engine.ts';
import { RuleSet } from '../src/kernel/services/RuleSet.ts';
import { Intent } from '../src/Intent.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;

const emptyBranch = new Branch.Value({ entries: [] });

const rule = (
	id: string,
	decisions: ReadonlyArray<DecisionValue>
): RuleModule.ToolCall => ({
	id,
	phase: 'toolCall',
	evaluate: () => Effect.succeed(decisions)
});

const evaluate = (rules: ReadonlyArray<RuleModule.Any>) =>
	Effect.provide(
		Engine.Service.use((engine) =>
			engine.evaluateToolCall({
				activeBranch: emptyBranch,
				cwd: '/project',
				writeIntent: new Intent.WriteFile({
					phase: 'before',
					filePath: 'src/x.ts',
					content: 'export const x = 1;'
				})
			})
		),
		Engine.layer.pipe(Layer.provide(RuleSet.of(rules)))
	);

describe('RuleEngine', () => {
	it.live('concatenates decisions from all matching-phase rules in order', () =>
		Effect.gen(function*() {
			const decisions = yield* evaluate([
				rule('first', [new Decision.BlockToolCall({ reason: 'a' })]),
				rule('second', [
					new Decision.InjectSystemPrompt({ content: 'header' })
				])
			]);
			expect(decisions.map((decision) => decision._tag)).toEqual([
				'BlockToolCall',
				'InjectSystemPrompt'
			]);
		}));

	it.live('empty rule set yields no decisions', () =>
		Effect.gen(function*() {
			const decisions = yield* evaluate([]);
			expect(decisions).toEqual([]);
		}));
});

describe('Decision schema', () => {
	it('round-trips every decision variant through the union codec', () => {
		const samples: ReadonlyArray<DecisionValue> = [
			new Decision.BlockToolCall({ reason: 'blocked' }),
			new Decision.InjectUserMessage({
				message: { content: 'hello', deliverAs: 'steer' }
			}),
			new Decision.InjectSystemPrompt({ content: 'policy' }),
			new Decision.AppendCustomEntry({
				customType: 'test-entry',
				data: { ok: true }
			})
		];
		for (const sample of samples) {
			const decoded = Schema.decodeUnknownSync(Decision.Value)(sample);
			expect(decoded._tag).toBe(sample._tag);
		}
	});
});
