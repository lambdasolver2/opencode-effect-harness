/**
 * Gate rule: blocks Effect-code writes until the ledger count reaches min;
 * deletion-only changes pass; advisory mode (strict=false) never blocks.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';

import { Gate } from '../src/rules/Gate.ts';

type Intent = Parameters<ReturnType<typeof Gate.rule>['evaluate']>[0]['writeIntent'];

const intent = (content: string): Intent =>
	({
		_tag: 'WriteFile',
		phase: 'before',
		filePath: 'src/effect-thing.ts',
		content
	}) as Intent;

const makeGate = (overrides?: {
	readonly min?: number;
	readonly strict?: boolean;
	readonly content?: string;
}) => {
	const evaluated: Array<string> = [];
	return {
		evaluated,
		rule: Gate.rule({
			min: overrides?.min ?? 4,
			strict: overrides?.strict ?? true,
			reason: (loaded) =>
				Effect.sync(() => {
					evaluated.push(`reason:${String(loaded)}`);
					return `blocked at ${String(loaded)}`;
				}),
			loaded: () => Effect.succeed(2),
			project: (_cwd, i) =>
				Effect.succeed(
					Option.some(
						overrides?.content !== undefined
							? overrides.content
							: i._tag === 'WriteFile'
								? i.content
								: i.replacements.map((r) => r.newText).join('\n')
					)
				)
		})
	};
};

const evaluate = (
	gate: ReturnType<typeof makeGate>['rule'],
	intent: Intent
) =>
	gate.evaluate({
		activeBranch: { entries: [] },
		cwd: '/project',
		sessionId: 'ses_test',
		writeIntent: intent
	});

describe('Gate', () => {
	it('blocks Effect-code writes below the threshold with a reason', async () => {
		const { rule, evaluated } = makeGate();
		const decisions = await Effect.runPromise(
			evaluate(rule, intent('import { Effect } from "effect";\n'))
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?._tag).toBe('BlockToolCall');
		const first = decisions[0];
		expect(first?._tag).toBe('BlockToolCall');
		expect(first && first._tag === 'BlockToolCall' ? first.reason : '').toBe('blocked at 2');
		expect(evaluated).toEqual(['reason:2']);
	});

	it('allows writes without Effect code (deletion-only cleanup)', async () => {
		const { rule } = makeGate({ content: '' });
		const decisions = await Effect.runPromise(
			evaluate(rule, intent('export const plain = 1;'))
		);
		expect(decisions).toEqual([]);
	});

	it('never blocks in advisory mode (strict=false)', async () => {
		const { rule } = makeGate({ strict: false });
		const decisions = await Effect.runPromise(
			evaluate(rule, intent('import { Effect } from "effect";\n'))
		);
		expect(decisions).toEqual([]);
	});

	it('passes once the loaded count reaches the minimum', async () => {
		// loaded=4 >= min=3 -> no block
		const gate = Gate.rule({
			min: 3,
			strict: true,
			reason: () => Effect.succeed('nope'),
			loaded: () => Effect.succeed(4),
			project: (_cwd, i) =>
				Effect.succeed(
					Option.some(
						i._tag === 'WriteFile'
							? i.content
							: i.replacements.map((r) => r.newText).join('\n')
					)
				)
		});
		const decisions = await Effect.runPromise(
			evaluate(gate, intent('Effect.succeed(1)'))
		);
		expect(decisions).toEqual([]);
	});
});
