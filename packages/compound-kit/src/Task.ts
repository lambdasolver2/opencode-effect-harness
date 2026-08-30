/**
 * Task — the DB-backed benchmark task domain (spec 06).
 *
 * A Task is a concrete problem plus evaluator/rubric references and the model
 * profiles selected for it. Revisions are immutable content snapshots; the
 * revision id is a drift fingerprint (fnv1a) over the canonical spec, computed
 * by the persistence layer. `referenceSolution` is evaluator-only reference
 * data: `renderCandidatePrompt` below takes ONLY candidate-visible fields, so
 * solution/rubric/history leakage is impossible by construction.
 *
 * Illegal states are unrepresentable: slugs, bounds and non-empty candidate
 * lists are enforced by the SCHEMA — there is no validating `if` anywhere.
 */
import { Array as Arr, Option, Schema } from 'effect';

import { ModelReference, modelKey } from 'opencode-harness-shared';
import { Slug } from 'opencode-harness-shared/Slug.ts';

export { Slug };

const BoundedNumber = (minimum: number, maximum: number) =>
	Schema.Finite.check(Schema.isBetween({ minimum, maximum }));

/** A user-curated LLM identity. `variant` is the EXACT catalog variant id
 *  (Model.VariantID) — never a guessed effort level. */
export class ModelProfile extends Schema.Class<ModelProfile>('ModelProfile')({
	id: Slug,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	variant: Schema.optionalKey(Schema.String)
}) {}

export const profileLabel = (profile: ModelProfile): string =>
	modelKey(
		new ModelReference({
			provider: profile.provider,
			model: profile.model,
			...(profile.variant === undefined ? {} : { variant: profile.variant })
		})
	);

export class TaskConstraints extends Schema.Class<TaskConstraints>('TaskConstraints')({
	/** Hard cap on candidate output length (chars). 500..500_000. */
	maxOutputChars: BoundedNumber(500, 500_000),
	/** Optional soft bounds the evaluator checks. */
	maxDomainTypes: Schema.optionalKey(BoundedNumber(1, 50)),
	maxModules: Schema.optionalKey(BoundedNumber(1, 50)),
	maxSnippets: Schema.optionalKey(BoundedNumber(1, 20))
}) {}

export class TaskSpec extends Schema.Class<TaskSpec>('TaskSpec')({
	taskId: Slug,
	title: Schema.NonEmptyString,
	domain: Schema.NonEmptyString,
	problem: Schema.NonEmptyString,
	/** Evaluator registry id, e.g. `design-brief@1`. */
	evaluatorId: Schema.NonEmptyString,
	/** Trusted judge rubric — never rendered into candidate prompts. */
	rubric: Schema.NonEmptyString,
	/** Evaluator-only reference; excluded from prompts by construction. */
	referenceSolution: Schema.optionalKey(Schema.String),
	/** Non-empty: a task without candidates is unrepresentable. */
	modelProfileIds: Schema.NonEmptyArray(Slug),
	/** Optional user-authored task prompt; when present it REPLACES the
	 *  default architect-prompt builder for the user turn. */
	prompt: Schema.optionalKey(Schema.NonEmptyString),
	constraints: TaskConstraints
}) {}

/** Immutable snapshot: spec + revision fingerprint + creation timestamp. */
export class Task extends Schema.Class<Task>('Task')({
	revision: Schema.String,
	createdAtMs: Schema.Number,
	spec: TaskSpec
}) {}

export class TaskError extends Schema.TaggedError<TaskError>()('TaskError', {
	operation: Schema.String,
	reason: Schema.String
}) {}

/**
 * Schema-driven validation: `decodeTaskSpec` is the ONLY constructor path
 * from untrusted input — invalid slugs / empty candidate lists are
 * unrepresentable.
 */
export const decodeTaskSpec = Schema.decodeUnknownSync(TaskSpec);

/**
 * The CANDIDATE-VISIBLE prompt. Takes only spec fields a candidate may see —
 * `rubric` and `referenceSolution` are not even parameters (privacy boundary,
 * unit-tested).
 */
export interface CandidatePrompt {
	readonly system: string;
	readonly user: string;
}

export const renderCandidatePrompt = (spec: TaskSpec): CandidatePrompt => {
	const bounds = Arr.getSomes([
		Option.map(
			Option.fromNullishOr(spec.constraints.maxSnippets),
			(max) => `- at most ${String(max)} Effect snippets`
		),
		Option.some(`- at most ${String(spec.constraints.maxOutputChars)} characters total`)
	]);
	return {
		system: [
			'You are a senior software architect producing a compact, high-signal design.',
			'Respond with a JSON document matching the requested structure exactly.',
			'Output is data: it will be parsed mechanically. No prose outside the JSON.'
		].join('\n'),
		user: Option.match(Option.fromNullishOr(spec.prompt), {
			onNone: () =>
				[
					`# Task: ${spec.title}`,
					'',
					spec.problem,
					'',
					'## Output contract (design-brief@1)',
					'JSON object with keys: summary (string), domainTypes (array of {name, code}),',
					'modules (array of {name, responsibility, dependsOn}), effectSnippets (array of {title, code}),',
					'decisions (array of {title, rationale}), risks (array of string).',
					'',
					'## Constraints',
					...bounds
				].join('\n'),
			onSome: (userPrompt) => `${userPrompt}\n\n## Constraints\n${bounds.join('\n')}`
		})
	};
};
