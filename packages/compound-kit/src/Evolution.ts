/**
 * Evolution — AVO-style prompt evolution over a fixed evaluation set.
 *
 * `Vary(P) = Agent(P, K, f)`:
 *  - P: scored lineage (committed versions + failed attempts w/ lessons)
 *  - K: knowledge base (mined insights, failure lessons, skills)
 *  - f: frozen train/holdout scoring function
 *
 * Commit discipline (from arXiv:2603.24517, applied to prompts):
 * verification must pass AND train/holdout scores strictly beat baseline.
 */
import { Context, Effect, Layer, Schema } from 'effect';

import type { Blueprint } from './Blueprint.ts';
import { FailureLesson } from './Trace.ts';

export class EvaluationSet extends Schema.Class<EvaluationSet>('EvaluationSet')(
	{
		trainTaskIds: Schema.Array(Schema.String),
		holdoutTaskIds: Schema.Array(Schema.String),
		evaluatorVersion: Schema.String
	}
) {}

export class CommittedVersion extends Schema.Class<CommittedVersion>(
	'CommittedVersion'
)({
	version: Schema.Number,
	markdownBlock: Schema.String,
	score: Schema.Number,
	baselineScore: Schema.Number,
	holdoutScore: Schema.optionalKey(Schema.Number),
	evaluatorVersion: Schema.String,
	diffSummary: Schema.String,
	committedAt: Schema.Number
}) {}

export class VariationAttempt extends Schema.Class<VariationAttempt>(
	'VariationAttempt'
)({
	id: Schema.String,
	proposedChange: Schema.String,
	outcome: Schema.Literals([
		'failed-verification',
		'score-regression',
		'abandoned'
	]),
	score: Schema.optionalKey(Schema.Number),
	lessonLearned: Schema.String
}) {}

export class Lineage extends Schema.Class<Lineage>('EvolutionLineage')({
	blueprintId: Schema.String,
	baselineScore: Schema.Number,
	evaluatorVersion: Schema.String,
	committed: Schema.Array(CommittedVersion),
	attempts: Schema.Array(VariationAttempt),
	lessons: Schema.Array(FailureLesson)
}) {}

export class Error extends Schema.TaggedError<Error>()('EvolutionError', {
	blueprintId: Schema.String,
	reason: Schema.String
}) {}

export interface ScoredCandidate {
	readonly version: number;
	readonly markdownBlock: string;
	readonly diffSummary: string;
	readonly trainScore: number;
	readonly holdoutScore: number;
	readonly verificationPassed: boolean;
}

export namespace Evolution {
	export interface Service {
		/** Persist a baseline; promotion is blocked without one. */
		readonly establishBaseline: (
			blueprint: Blueprint,
			set: EvaluationSet,
			scores: { readonly train: number; readonly holdout: number }
		) => Effect.Effect<Lineage>;
		/** Commit iff verification passed AND train+holdout strictly improve. */
		readonly commit: (
			lineage: Lineage,
			candidate: ScoredCandidate
		) => Effect.Effect<
			{ readonly lineage: Lineage; readonly committed: boolean },
			Error
		>;
		/** Record a rejected attempt with its lesson. */
		readonly journalAttempt: (
			lineage: Lineage,
			attempt: VariationAttempt
		) => Effect.Effect<Lineage>;
		/** True when stagnationLimit consecutive attempts did not improve. */
		readonly stagnant: (lineage: Lineage, limit: number) => boolean;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'ox-effect-harness/compound/Evolution'
	) {}

	export const makeLayer = Layer.effect(
		Tag,
		Effect.succeed(
			Tag.of({
				establishBaseline: (blueprint, set, scores) =>
					Effect.succeed(
						new Lineage({
							blueprintId: blueprint.id,
							baselineScore: scores.train,
							evaluatorVersion: set.evaluatorVersion,
							committed: [],
							attempts: [],
							lessons: []
						})
					),
				commit: (lineage, candidate) => {
					if (!candidate.verificationPassed) {
						return Effect.fail(
							new Error({
								blueprintId: lineage.blueprintId,
								reason: 'verification-failed'
							})
						);
					}
					if (
						candidate.trainScore <= lineage.baselineScore ||
						candidate.holdoutScore <= lineage.baselineScore
					) {
						return Effect.fail(
							new Error({
								blueprintId: lineage.blueprintId,
								reason: 'score-regression'
							})
						);
					}
					const next = new Lineage({
						...lineage,
						committed: [
							...lineage.committed,
							new CommittedVersion({
								version:
									lineage.committed.length === 0
										? 1
										: Math.max(
												...lineage.committed.map((v) => v.version)
											) + 1,
								markdownBlock: candidate.markdownBlock,
								score: candidate.trainScore,
								baselineScore: lineage.baselineScore,
								holdoutScore: candidate.holdoutScore,
								evaluatorVersion: lineage.evaluatorVersion,
								diffSummary: candidate.diffSummary,
								committedAt: Date.now()
							})
						]
					});
					return Effect.succeed({ lineage: next, committed: true });
				},
				journalAttempt: (lineage, attempt) =>
					Effect.succeed(
						new Lineage({ ...lineage, attempts: [...lineage.attempts, attempt] })
					),
				stagnant: (lineage, limit) => {
					const tail = lineage.attempts.slice(-limit);
					return tail.length >= limit;
				}
			})
		)
	);
}
