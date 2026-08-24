/**
 * Benchmark aggregation: per-model scorecard, mean score, passed counts,
 * n=1 labeling.
 */
import { describe, expect, it } from 'vitest';

import { aggregate, Run } from '../src/Benchmark.ts';

const run = (
	model: string,
	taskId: string,
	score: number,
	passed = score >= 0.5
): Run =>
	new Run({
		blueprintId: 'bp-1',
		modelProvider: model.split('/')[0] ?? '',
		modelName: model.split('/')[1] ?? '',
		taskId,
		score,
		passed,
		durationMs: 100
	});

describe('Benchmark.aggregate', () => {
	it('groups by model and computes mean scores', () => {
		const card = aggregate([
			run('openai/gpt-5', 't1', 0.9),
			run('openai/gpt-5', 't2', 0.7),
			run('anthropic/claude-4-5', 't1', 0.6)
		]);
		expect(card.trialsPerModel).toBe(1);

		const gpt = card.rows.find((r) => r.modelName === 'gpt-5');
		const claude = card.rows.find((r) => r.modelName === 'claude-4-5');
		expect(gpt?.aggregateScore).toBeCloseTo(0.8);
		expect(claude?.aggregateScore).toBeCloseTo(0.6);
	});

	it('counts tasks passed correctly', () => {
		const card = aggregate([
			run('openai/gpt-5', 't1', 0.9),
			run('openai/gpt-5', 't2', 0.3),
			run('openai/gpt-5', 't3', 0.8)
		]);
		const row = card.rows[0];
		expect(row?.tasksPassed).toBe(2);
		expect(row?.tasksTotal).toBe(3);
	});

	it('returns empty rows for empty runs', () => {
		expect(aggregate([]).rows).toEqual([]);
	});
});
