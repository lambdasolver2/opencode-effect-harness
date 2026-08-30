/**
 * SemanticReviewer — pluggable LLM review over a bounded ChangeSet. The core
 * defines the contract and the explicit skipped state; the host adapter
 * implements it with a read-only worker. A skipped review is NEVER folded
 * into a pass (spec A5) — `overall()` treats it as its own state.
 */
import { Context, Effect, Layer, Schema } from 'effect';

import type { ChangeSet } from './change/Set.ts';
import type { CheckerResult, Diagnostic } from './Checker.ts';
import { ReviewFinding, SemanticReview } from './Report.ts';

export class ReviewerError extends Schema.TaggedError<ReviewerError>()(
	'ReviewerError',
	{ reason: Schema.String }
) {}

export interface ReviewInput {
	readonly sessionID: string;
	readonly checks: ReadonlyArray<
		Pick<CheckerResult, 'specId' | 'kind' | 'verdict' | 'diagnostics'>
	>;
	readonly changeSet: ChangeSet;
	/** Loaded skill names for skills-compliance review (bounded bodies upstream). */
	readonly loadedSkills: ReadonlyArray<string>;
}

export namespace Reviewer {
	export interface Interface {
		review(input: ReviewInput): Effect.Effect<SemanticReview, ReviewerError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/verification/Reviewer'
	) {}

	/** Explicit-skipped reviewer used when semanticReview is disabled. */
	export const makeSkipped = (): Interface => ({
		review: () =>
			Effect.succeed(new SemanticReview({ status: 'skipped', findings: [] }))
	});

	export const layerSkipped = Layer.succeed(Service, Service.of(makeSkipped()));

	/** Parse untrusted worker output into findings; malformed output is an error — any invalid entry fails the whole decode (strict, not silent drop). */
	export const decodeFindings = (
		raw: string
	): Effect.Effect<ReadonlyArray<ReviewFinding>, ReviewerError> =>
		Effect.try({
			try: () => {
				const jsonCodec = Schema.fromJsonString(Schema.Array(ReviewFinding));
				return Schema.decodeSync(jsonCodec)(raw);
			},
			catch: (cause) =>
				new ReviewerError({ reason: `unparseable review output: ${String(cause)}` })
		});
}
