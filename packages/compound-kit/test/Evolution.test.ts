/**
 * Evolution commit discipline (AVO): verification gate + strict train/holdout
 * improvement; rejected attempts are journaled with lessons, never promoted.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import type { Blueprint } from '../src/Blueprint.ts';
import { ExecutionSpec } from '../src/Blueprint.ts';
import { Evolution } from '../src/Evolution.ts';
import { EvaluationSet } from '../src/Evolution.ts';

const blueprint = (): Blueprint => ({
	id: 'bp-1',
	name: 'test',
	version: 1,
	domain: 'coding',
	systemPrompt: 'p',
	procedure: [],
	pitfalls: [],
	modules: [],
	execution: new ExecutionSpec({
		workerAgent: 'explore',
		tools: ['read'],
		maxTurns: 10,
		timeoutMs: 60000
	}),
	acceptance: [],
	origins: [],
	createdAt: 0
});

const set = new EvaluationSet({
	trainTaskIds: ['t1', 't2'],
	holdoutTaskIds: ['h1'],
	evaluatorVersion: 'eval-v1'
});

const layer = Evolution.makeLayer;

const run = <A, E>(
	f: (evo: Evolution.Service) => Effect.Effect<A, E>
) => Effect.provide(Evolution.Tag.use(f), Evolution.makeLayer);

describe('Evolution commit discipline', () => {
	it.live('establishes a baseline lineage', () =>
		run((evo: Evolution.Service) =>
			Effect.gen(function*() {
				const lineage = yield* evo.establishBaseline(
					blueprint(),
					set,
					{ train: 0.5, holdout: 0.5 }
				);
				expect(lineage.baselineScore).toBe(0.5);
				expect(lineage.evaluatorVersion).toBe('eval-v1');
				expect(lineage.committed).toHaveLength(0);
			})
		));

	it.live('commits candidates that strictly beat the baseline on train+holdout', () =>
		run((evo: Evolution.Service) =>
			Effect.gen(function*() {
				const baseline = yield* evo.establishBaseline(
					blueprint(),
					set,
					{ train: 0.5, holdout: 0.5 }
				);
				const { lineage, committed } = yield* evo.commit(baseline, {
					version: 1,
					markdownBlock: '## Version v1',
					diffSummary: 'added diagnosis checklist',
					trainScore: 0.7,
					holdoutScore: 0.65,
					verificationPassed: true
				});
				expect(committed).toBe(true);
				expect(lineage.committed).toHaveLength(1);
				expect(lineage.committed[0]?.score).toBe(0.7);
			})
		));

	it.live('rejects candidates that fail verification', () =>
		run((evo: Evolution.Service) =>
			Effect.gen(function*() {
				const baseline = yield* evo.establishBaseline(
					blueprint(),
					set,
					{ train: 0.5, holdout: 0.5 }
				);
				const result = yield* evo.commit(baseline, {
					version: 1,
					markdownBlock: 'x',
					diffSummary: '',
					trainScore: 0.9,
					holdoutScore: 0.9,
					verificationPassed: false
				}).pipe(Effect.flip);
				expect(result.reason).toBe('verification-failed');
			})
		));

	it.live('rejects score regressions and equal scores', () =>
		run((evo: Evolution.Service) =>
			Effect.gen(function*() {
				const baseline = yield* evo.establishBaseline(
					blueprint(),
					set,
					{ train: 0.5, holdout: 0.5 }
				);
				const equalTrain = yield* evo.commit(baseline, {
					version: 1,
					markdownBlock: 'x',
					diffSummary: '',
					trainScore: 0.5,
					holdoutScore: 0.6,
					verificationPassed: true
				}).pipe(Effect.flip);
				expect(equalTrain.reason).toBe('score-regression');

				const lowerHoldout = yield* evo.commit(baseline, {
					version: 1,
					markdownBlock: 'x',
					diffSummary: '',
					trainScore: 0.8,
					holdoutScore: 0.4,
					verificationPassed: true
				}).pipe(Effect.flip);
				expect(lowerHoldout.reason).toBe('score-regression');
			})
		));

	it.live('journals failed attempts as lessons without promoting them', () =>
		run((evo: Evolution.Service) =>
			Effect.gen(function*() {
				const baseline = yield* evo.establishBaseline(
					blueprint(),
					set,
					{ train: 0.5, holdout: 0.5 }
				);
				const journaled = yield* evo.journalAttempt(baseline, {
					id: 'attempt-1',
					proposedChange: 'add chain-of-thought',
					outcome: 'score-regression',
					score: 0.3,
					lessonLearned: 'verbose reasoning hurts this task'
				});
				expect(journaled.attempts).toHaveLength(1);
				expect(journaled.committed).toHaveLength(0);
				expect(journaled.attempts[0]?.lessonLearned).toContain('verbose');
			})
		));

	it.live('detects stagnation after limit consecutive attempts', () =>
		run((evo: Evolution.Service) =>
			Effect.gen(function*() {
				let lineage = yield* evo.establishBaseline(
					blueprint(),
					set,
					{ train: 0.5, holdout: 0.5 }
				);
				for (let i = 0; i < 3; i++) {
					lineage = yield* evo.journalAttempt(lineage, {
						id: `a${String(i)}`,
						proposedChange: `change ${String(i)}`,
						outcome: 'abandoned',
						lessonLearned: `lesson ${String(i)}`
					});
				}
				expect(evo.stagnant(lineage, 3)).toBe(true);
				expect(evo.stagnant({ ...lineage, attempts: lineage.attempts.slice(0, 2) }, 3)).toBe(false);
			})
		));
});
