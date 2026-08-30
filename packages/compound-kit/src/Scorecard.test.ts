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
			aggregate([run('openai/gpt-5', 't1', 0.9)], input)
		)
		expect(card.trialsPerModel).toBe(1)
		expect(card.rows[0]?.aggregateScore).toBeCloseTo(0.9)
	})

	it('rejects duplicate trial keys', async () => {
		const exit = await Effect.runPromiseExit(
			aggregate([run('a/m', 't1', 0.9), run('a/m', 't1', 0.8)], input)
		)
		expect(exit._tag).toBe('Failure')
	})

	it('rejects invalid scores', async () => {
		const exit = await Effect.runPromiseExit(aggregate([run('a/m', 't1', -1)], input))
		expect(exit._tag).toBe('Failure')
	})

	it('requires every model to cover every task', async () => {
		const exit = await Effect.runPromiseExit(
			aggregate(
				[run('a/first', 't1', 1), run('a/second', 't1', 1)],
				{ ...input, expectedTasks: ['t1', 't2'] }
			)
		)
		expect(exit._tag).toBe('Failure')
	})

	it('treats model variants as DISTINCT identities (no collision)', async () => {
		const withVariant = (variant: string): Run =>
			new Run({
				blueprintId: 'bp-1', modelProvider: 'a', modelName: 'm', modelVariant: variant,
				taskId: 't1', score: 0.9, passed: true, durationMs: 10, evaluatorVersion: 'v1'
			})
		const card = await Effect.runPromise(
			aggregate([withVariant('fast'), withVariant('deep')], input)
		)
		expect(card.rows).toHaveLength(2)
		expect(card.rows.map((r) => r.modelVariant).sort()).toEqual(['deep', 'fast'])
	})

	it('keeps the same model without variant distinct from its variants', async () => {
		const exit = await Effect.runPromiseExit(
			aggregate(
				[
					new Run({ blueprintId: 'bp-1', modelProvider: 'a', modelName: 'm', taskId: 't1', score: 0.9, passed: true, durationMs: 10, evaluatorVersion: 'v1' }),
					new Run({ blueprintId: 'bp-1', modelProvider: 'a', modelName: 'm', modelVariant: 'deep', taskId: 't1', score: 0.8, passed: true, durationMs: 10, evaluatorVersion: 'v1' })
				],
				input
			)
		)
		expect(exit._tag).toBe('Success')
		const card = exit._tag === 'Success' ? exit.value : undefined
		expect(card?.rows).toHaveLength(2)
	})
})
