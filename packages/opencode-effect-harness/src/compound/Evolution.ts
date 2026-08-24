/**
 * Evolution — AVO-style prompt evolution with HARD safety rails:
 *  - promotion requires verification pass AND strict improvement of BOTH the
 *    train AND hidden-holdout bests
 *  - the baseline is persisted and evaluator-version bound; stale manifests
 *    block commits entirely
 *  - committed versions advance a running-best; regressions vs the running
 *    best are rejected even when they beat the ORIGINAL baseline
 *  - failed attempts are journaled with lessons and never promoted
 *  - stagnation counts CONSECUTIVE attempts since the last commit
 */
import { Context, Effect, Layer, Schema } from 'effect';

import type { Blueprint } from './Blueprint.ts';
import { FailureLesson } from './Trace.ts';

export class EvaluationSet extends Schema.Class<EvaluationSet>('EvaluationSet')({
	trainTaskIds: Schema.Array(Schema.String),
	holdoutTaskIds: Schema.Array(Schema.String),
	evaluatorVersion: Schema.String
}) {}

export class Baseline extends Schema.Class<Baseline>('Baseline')({
	train: Schema.Number,
	holdout: Schema.Number,
	evaluatorVersion: Schema.String,
	recordedAt: Schema.Number
}) {}

export class CommittedVersion extends Schema.Class<CommittedVersion>(
	'CommittedVersion'
)({
	version: Schema.Number,
	markdownBlock: Schema.String,
	score: Schema.Number,
	holdoutScore: Schema.Number,
	diffSummary: Schema.String,
	committedAt: Schema.Number
}) {}

export const AttemptOutcome = Schema.Literals([
	'failed-verification',
	'score-regression',
	'stale-evaluator',
	'version-conflict',
	'abandoned'
] as const);

export class VariationAttempt extends Schema.Class<VariationAttempt>(
	'VariationAttempt'
)({
	id: Schema.String,
	proposedChange: Schema.String,
	outcome: AttemptOutcome,
	score: Schema.optionalKey(Schema.Number),
	lessonLearned: Schema.String
}) {}

export class Lineage extends Schema.Class<Lineage>('EvolutionLineage')({
	blueprintId: Schema.String,
	baseline: Baseline,
	bestTrain: Schema.Number,
	bestHoldout: Schema.Number,
	committed: Schema.Array(CommittedVersion),
	attempts: Schema.Array(VariationAttempt),
	attemptsSinceLastCommit: Schema.Number,
	lessons: Schema.Array(FailureLesson)
}) {}

export class Error extends Schema.TaggedError<Error>()('EvolutionError', {
	blueprintId: Schema.String,
	reason: Schema.String
}) {}

export interface ScoredCandidate {
	readonly requestedVersion: number;
	readonly markdownBlock: string;
	readonly diffSummary: string;
	readonly trainScore: number;
	readonly holdoutScore: number;
	readonly verificationPassed: boolean;
	readonly evaluatorVersion: string;
}

export namespace Evolution {
	export interface Service {
		establishBaseline(input: {
			readonly blueprint: Blueprint;
			readonly set: EvaluationSet;
			readonly scores: { readonly train: number; readonly holdout: number };
			readonly now: number;
		}): Effect.Effect<Lineage>;
		commit(input: {
			readonly lineage: Lineage;
			readonly candidate: ScoredCandidate;
			readonly now: number;
		}): Effect.Effect<
			{ readonly lineage: Lineage; readonly committed: boolean },
			Error
		>;
		journalAttempt(input: {
			readonly lineage: Lineage;
			readonly attempt: VariationAttempt;
		}): Effect.Effect<Lineage>;
		stagnant(lineage: Lineage, limit: number): boolean;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/Evolution'
	) {}

	const fail = (blueprintId: string, reason: string) => new Error({ blueprintId, reason });

	export const make = (): Service => ({
		establishBaseline: ({ blueprint, set, scores, now }) =>
			Effect.succeed(
				new Lineage({
					blueprintId: blueprint.id,
					baseline: new Baseline({
						train: scores.train,
						holdout: scores.holdout,
						evaluatorVersion: set.evaluatorVersion,
						recordedAt: now
					}),
					bestTrain: scores.train,
					bestHoldout: scores.holdout,
					committed: [],
					attempts: [],
					attemptsSinceLastCommit: 0,
					lessons: []
				})
			),

		commit: ({ lineage, candidate, now }) =>
			Effect.gen(function*() {
				if (candidate.evaluatorVersion !== lineage.baseline.evaluatorVersion) {
					return yield* Effect.fail(
						fail(lineage.blueprintId, 'stale-evaluator')
					);
				}
				if (!candidate.verificationPassed) {
					return yield* Effect.fail(fail(lineage.blueprintId, 'verification-failed'));
				}
				const nextVersion =
					lineage.committed.length === 0
						? 1
						: Math.max(...lineage.committed.map((v) => v.version)) + 1;
				if (candidate.requestedVersion !== nextVersion) {
					return yield* Effect.fail(fail(lineage.blueprintId, 'version-conflict'));
				}
				if (
					!(
						candidate.trainScore > lineage.bestTrain &&
						candidate.holdoutScore > lineage.bestHoldout
					)
				) {
					return yield* Effect.fail(fail(lineage.blueprintId, 'score-regression'));
				}

				const next = new Lineage({
					...lineage,
					bestTrain: candidate.trainScore,
					bestHoldout: candidate.holdoutScore,
					attemptsSinceLastCommit: 0,
					committed: [
						...lineage.committed,
						new CommittedVersion({
							version: candidate.requestedVersion,
							markdownBlock: candidate.markdownBlock,
							score: candidate.trainScore,
							holdoutScore: candidate.holdoutScore,
							diffSummary: candidate.diffSummary,
							committedAt: now
						})
					]
				});
				return { lineage: next, committed: true };
			}),

		journalAttempt: ({ lineage, attempt }) =>
			Effect.succeed(
				new Lineage({
					...lineage,
					attempts: [...lineage.attempts, attempt],
					attemptsSinceLastCommit: lineage.attemptsSinceLastCommit + 1
				})
			),

		stagnant: (lineage, limit) => limit >= 1 && lineage.attemptsSinceLastCommit >= limit
	});

	export const layer: Layer.Layer<Tag> = Layer.succeed(Tag, Tag.of(make()));
}
