import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { aggregate, Run } from './Scorecard.ts'

const run = (model: string, taskId: string, score: number): Run =>
	new Run({
		blueprintId: 'bp-1',
		modelProvider: model.split('/')[0] ?? '',
		modelName: model.split('/')[1] ?? '',
		taskId,
		score,
		passed: score >= 0.5,
		durationMs: 100,
		evaluatorVersion: 'v1'
	})

const input = { evaluatorVersion: 'v1', blueprintId: 'bp-1', expectedTasks: ['t1'] }

describe('Scorecard.aggregate', () => {
	it('groups by model and computes mean scores', async () => {
		const card = await Effect.runPromise(
			aggregate([run('openai/gpt-5', 't1', 0.9), run('openai/gpt-5', 't2', 0.7)], input)
		)
		expect(card.trialsPerModel).toBe(1)
		expect(card.rows[0]?.aggregateScore).toBeCloseTo(0.8)
	})

	it('rejects duplicate trial keys', async () => {
		const exit = await Effect.runPromiseExit(
			aggregate([run('a/m', 't1', 0.9), run('a/m', 't1', 0.8)], input)
		)
		expect(exit._tag).toBe('Failure')
	})
})
