/**
 * Distill: two-stage pipeline with a stub LLM — verifies prompt construction,
 * JSON parsing, gate decisions, and null-bias defaults.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import { Distill } from '../src/Distill.ts';
import { Llm } from '../src/Llm.ts';

const digest = JSON.stringify({
	taskPrompt: 'fix the race condition',
	attemptedStrategy: 'added a mutex',
	observableSteps: ['read code', 'added lock'],
	failure: 'still flaky',
	detection: 'CI caught it',
	correction: 'used STM instead',
	transferableLesson: 'STM beats raw locks for compound state',
	score: 0.9
});

const candidates = [
	{
		kind: 'failure-pattern' as const,
		domain: 'coding',
		anchor: 'Concurrency',
		content: 'Use STM for compound state mutations.',
		evidence: '[user]: "stop using raw mutexes"',
		confidence: 'high' as const
	},
	{
		kind: 'preference' as const,
		domain: 'coding',
		anchor: 'append',
		content: 'Weak candidate with no real signal.',
		evidence: '',
		confidence: 'low' as const
	}
];

const modelRef = { provider: 'openai', model: 'gpt-5' };

const makeDistillLayer = (responses: ReadonlyArray<string>) => {
	let call = 0;
	const llmStub = Llm.layer({
		complete: () => {
			const text = responses[call] ?? '{"candidates":[]}';
			call += 1;
			return Effect.succeed({
				text,
				tokensIn: 100,
				tokensOut: 50,
				durationMs: 500
			});
		}
	});
	return Layer.mergeAll(Distill.layer).pipe(Layer.provide(Layer.mergeAll(llmStub)));
};

describe('Distill', () => {
	it.live('stage 1 extract parses valid JSON array', () =>
		Effect.gen(function*() {
			const distill = yield* Distill.Tag;
			const result = yield* distill.extract(
				[JSON.parse(digest)],
				'# Concurrency\nUse STM.',
				modelRef as never
			);
			expect(result.length).toBeGreaterThan(0);
			expect(result[0]?.domain).toBe('coding');
		}).pipe(Effect.provide(makeDistillLayer([JSON.stringify([candidates[0]])]))));

	it.live('stage 2 gate returns approve/reject per candidate', () =>
		Effect.gen(function*() {
			const distill = yield* Distill.Tag;
			const result = yield* distill.gate(
				candidates,
				'# KB',
				modelRef as never
			);
			expect(result.length).toBe(2);
			expect(result[0]?.decision).toBe('approve');
			expect(result[1]?.decision).toBe('reject'); // null bias
		}).pipe(Effect.provide(makeDistillLayer([
			JSON.stringify([
				{ insightId: '0', decision: 'approve', confidence: 'high' },
				{ insightId: '1', decision: 'reject', reason: 'no evidence' }
			])
		]))));

	it.live('malformed JSON in stage 1 produces typed error', () =>
		Effect.gen(function*() {
			const distill = yield* Distill.Tag;
			const error = yield* Effect.flip(
				distill.extract([], '', modelRef as never)
			);
			expect(error.stage).toBe('extract');
			expect(error.reason).toContain('invalid JSON');
		}).pipe(Effect.provide(makeDistillLayer(['not-json']))));
});
