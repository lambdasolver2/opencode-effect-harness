/**
 * Blueprint patch fold: pure, order-sensitive, foreign ids skipped,
 * execution spec replaced immutably.
 */
import { describe, expect, it } from 'vitest';

import { applyPatches, ExecutionSpec, Patch } from '../src/Blueprint.ts';
import type { Blueprint } from '../src/Blueprint.ts';

const base = (): Blueprint => ({
	id: 'bp-1',
	name: 'error-recovery',
	version: 1,
	domain: 'coding',
	systemPrompt: 'base prompt',
	procedure: ['step a', 'step b'],
	pitfalls: [],
	modules: [],
	execution: new ExecutionSpec({
		workerAgent: 'explore',
		tools: ['read'],
		maxTurns: 20,
		timeoutMs: 600000
	}),
	acceptance: [],
	origins: ['ses_1'],
	createdAt: 0
});

describe('applyPatches', () => {
	it('adds procedure steps immutably', () => {
		const original = base();
		const next = applyPatches(original, [
			new Patch({
				blueprintId: 'bp-1',
				description: 'add step',
				changes: [{ _tag: 'add-procedure-step', value: 'step c' }]
			})
		]);
		expect(next.procedure).toEqual(['step a', 'step b', 'step c']);
		// original untouched (pure fold)
		expect(original.procedure).toEqual(['step a', 'step b']);
	});

	it('removes procedure steps by exact match', () => {
		const next = applyPatches(base(), [
			new Patch({
				blueprintId: 'bp-1',
				description: 'remove',
				changes: [{ _tag: 'remove-procedure-step', value: 'step a' }]
			})
		]);
		expect(next.procedure).toEqual(['step b']);
	});

	it('replaces the system prompt', () => {
		const next = applyPatches(base(), [
			new Patch({
				blueprintId: 'bp-1',
				description: 'rewrite prompt',
				changes: [{ _tag: 'set-system-prompt', value: 'improved prompt' }]
			})
		]);
		expect(next.systemPrompt).toBe('improved prompt');
	});

	it('updates execution limits only when provided', () => {
		const next = applyPatches(base(), [
			new Patch({
				blueprintId: 'bp-1',
				description: 'tighten',
				changes: [
					{
						_tag: 'set-execution',
						maxTurns: 10
					}
				]
			})
		]);
		expect(next.execution.maxTurns).toBe(10);
		expect(next.execution.timeoutMs).toBe(600000); // preserved
	});

	it('ignores patches for other blueprints', () => {
		const original = base();
		const next = applyPatches(original, [
			new Patch({
				blueprintId: 'other-bp',
				description: 'foreign',
				changes: [{ _tag: 'set-system-prompt', value: 'hijack' }]
			})
		]);
		expect(next).toBe(original);
	});

	it('applies multiple patches in order as a fold', () => {
		const next = applyPatches(base(), [
			new Patch({
				blueprintId: 'bp-1',
				description: 'one',
				changes: [{ _tag: 'add-pitfall', value: 'pitfall 1' }]
			}),
			new Patch({
				blueprintId: 'bp-1',
				description: 'two',
				changes: [{ _tag: 'add-pitfall', value: 'pitfall 2' }]
			})
		]);
		expect(next.pitfalls).toEqual(['pitfall 1', 'pitfall 2']);
	});
});
