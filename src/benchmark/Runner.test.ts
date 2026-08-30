import { describe, expect, it } from 'vitest'
import { Effect, Layer, Option } from 'effect'
import { TaskError, TaskSpec, renderCandidatePrompt } from 'opencode-compound-kit/Task.ts'
import { TaskStore } from 'opencode-compound-kit/task/Store.ts'
import { Runner } from './Runner.ts'
import { ExecutorError } from '../session/Executor.ts'
import { SqliteStore } from 'opencode-bench-store'

const layerForTest = () => SqliteStore.layer({ _tag: 'Memory' })

const withStore = <A, E>(
	effect: Effect.Effect<A, E, TaskStore.Tag>
): Effect.Effect<A, E | TaskError | import('effect/unstable/sql/SqlError').SqlError, never> =>
	Effect.provide(effect, layerForTest()) as Effect.Effect<
		A,
		E | TaskError | import('effect/unstable/sql/SqlError').SqlError,
		never
	>

const spec = new TaskSpec({
	taskId: 't1',
	title: 'Architect motel',
	domain: 'architecture',
	problem: 'Design the motel OTLP ingest + viewer.',
	evaluatorId: 'design-brief@1',
	rubric: 'RUBRIC-CONFIDENTIAL-TEXT',
	referenceSolution: 'REFERENCE-SOLUTION-CONFIDENTIAL',
	modelProfileIds: ['strong', 'weak', 'broken'],
	constraints: { maxOutputChars: 8000, maxSnippets: 6 }
})

const briefJson = (quality: 'good' | 'poor'): string =>
	JSON.stringify({
		summary: `Compact design (${quality})`,
		domainTypes: [{ name: 'SpanId', code: 'export type SpanId = string' }],
		modules: [
			{ name: 'Ingest', responsibility: 'OTLP decode', dependsOn: ['Store'] },
			{ name: 'Store', responsibility: 'SQLite persistence', dependsOn: [] }
		],
		effectSnippets: [
			{
				title: 'types',
				code: 'export type SpanId = string\nexport interface Trace { readonly traceId: SpanId }'
			}
		],
		decisions: [{ title: 'WAL', rationale: 'single-writer friendly' }],
		risks: ['retention growth']
	})

const judgeVerdict = (domain: number): string =>
	JSON.stringify({
		scores: { domain, modularity: 0.8, effectSyntax: 0.8, iteration: 0.8, concreteness: 0.8 }
	})

const makeExecutor = (
	answers: ReadonlyMap<string, string>
): Runner.Deps['executor'] => ({
	run: (request) => {
		if (request.label.startsWith('judge:')) {
			const domain = request.user.includes('(good)') ? 0.95 : 0.4
			return Effect.succeed({
				text: judgeVerdict(domain),
				durationMs: 1,
				sessionId: 'judge-session',
				releaseOrigin: Effect.void
			})
		}
		const answer = answers.get(request.profile.id)
		if (answer === undefined) {
			return Effect.fail(new ExecutorError({ operation: 'generate', reason: 'transport down' }))
		}
		return Effect.succeed({
			text: answer,
			durationMs: 5,
			sessionId: `child-${request.profile.id}`,
			releaseOrigin: Effect.void
		})
	}
})

describe('renderCandidatePrompt (privacy boundary)', () => {
	it('never contains the reference solution or the rubric', () => {
		const prompt = renderCandidatePrompt(spec)
		expect(prompt.system).not.toContain('REFERENCE-SOLUTION-CONFIDENTIAL')
		expect(prompt.user).not.toContain('REFERENCE-SOLUTION-CONFIDENTIAL')
		expect(prompt.system).not.toContain('RUBRIC-CONFIDENTIAL-TEXT')
		expect(prompt.user).not.toContain('RUBRIC-CONFIDENTIAL-TEXT')
		expect(prompt.user).toContain('Design the motel OTLP ingest')
	})
})

describe('Runner.run (fake executor, in-memory store)', () => {
	it('scores candidates, records failures, and selects the deterministic leader', async () => {
		const result = await Effect.runPromise(
			withStore(
				Effect.gen(function*() {
					const store = yield* TaskStore.Tag
					yield* store.upsertTask({ spec, revision: 'rev-t1', now: 1_000 })
					const taskOption = yield* store.getTask('t1')
					const task = Option.getOrThrow(taskOption)
					const summary = yield* Runner.run(
						{
							store,
							executor: makeExecutor(
								new Map([
									['strong', briefJson('good')],
									['weak', briefJson('poor')]
								])
							),
							judgeProfile: { id: 'judge', provider: 'opencode', model: 'judge-model' },
							workspaceDirFor: () => Effect.succeed('/tmp/bench-test'),
							cleanupWorkspace: () => Effect.void,
							workerAgent: 'explore',
							timeoutMs: 60_000
						},
						{
							task,
							profiles: task.spec.modelProfileIds.map((id) => ({
								id,
								provider: 'opencode',
								model: 'm'
							})),
							trials: 1,
							concurrency: 3
						}
					)
					const trials = yield* store.listTrials(summary.jobId)
					const history = yield* store.listHistory(summary.jobId)
					const leading = yield* store.getLeading(summary.jobId)
					const job = yield* store.getJob(summary.jobId)
					return { summary, trials, history, leading, job }
				})
			)
		)
		const { summary, trials, history, leading, job } = result
		expect(summary.outcomes).toHaveLength(3)
		expect(summary.outcomes.map((o) => o.status).sort()).toEqual([
			'llm-error',
			'scored',
			'scored'
		])
		expect(summary.leadingTrialId?.endsWith(':strong:1') ?? false).toBe(true)
		expect((summary.leadingTotal ?? 0) > 0.5).toBe(true)

		expect(trials.find((t) => t.profileId === 'broken')?.status).toBe('llm-error')
		expect(history.map((e) => e.kind)).toEqual(['job.started', 'job.completed'])
		expect(Option.isSome(leading) && leading.value.trialId === summary.leadingTrialId).toBe(true)
		expect(Option.isSome(job) && job.value.status === 'completed').toBe(true)
	})
})
