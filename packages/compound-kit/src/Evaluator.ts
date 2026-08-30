/**
 * Evaluator — task scoring for benchmark mode (spec 06 §4).
 *
 * Two independent components, NEVER folded silently:
 *  1. deterministic checks — Schema-decoded `DesignBrief`, bounds adherence,
 *     and ast-grep SYNTAX diagnostics over TS snippets (Syntax is parse-only;
 *     it is never reported as semantic verification);
 *  2. judge dimensions — an injected `Judge` port (LLM rubric scoring).
 * The weighted total is computed in code from bounded dimension scores.
 * A judge failure is a typed `judge-unavailable` outcome, never a pass.
 */
import { Context, Effect, Option, Order, Schema } from 'effect';
import { sort } from 'effect/Array';

import * as Syntax from 'opencode-harness-kit/Syntax.ts';

import { TaskConstraints, TaskError } from './Task.ts';

// ---------------------------------------------------------------------------
// Candidate output contract: design-brief@1
// ---------------------------------------------------------------------------

export class DesignBrief extends Schema.Class<DesignBrief>('DesignBrief')({
	summary: Schema.String,
	domainTypes: Schema.Array(
		Schema.Struct({ name: Schema.String, code: Schema.String })
	),
	modules: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			responsibility: Schema.String,
			dependsOn: Schema.Array(Schema.String)
		})
	),
	effectSnippets: Schema.Array(
		Schema.Struct({ title: Schema.String, code: Schema.String })
	),
	decisions: Schema.Array(
		Schema.Struct({ title: Schema.String, rationale: Schema.String })
	),
	risks: Schema.Array(Schema.String)
}) {}

const decodeBriefSync = Schema.decodeUnknownSync(
	Schema.Union([DesignBrief, Schema.fromJsonString(DesignBrief)])
);
const decodeBrief = Option.liftThrowable(decodeBriefSync);

export class EvaluatorError extends Schema.TaggedError<EvaluatorError>()(
	'EvaluatorError',
	{ operation: Schema.String, reason: Schema.String }
) {}

export interface DeterministicResult {
	readonly contractValid: boolean;
	readonly findings: ReadonlyArray<string>;
	readonly score: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const boundsPenalty = (
	count: number,
	max: number | undefined,
	findings: Array<string>,
	label: string
): number => {
	if (max === undefined || count <= max) return 1;
	findings.push(`${label}: ${String(count)} > bound ${String(max)}`);
	return max / count;
};

/**
 * Deterministic evaluation of ONE candidate output. Pure. Structural score:
 * contract validity gate, bounds adherence, and parse-clean snippets.
 */
export const evaluateDesignBrief = (
	output: string,
	constraints: TaskConstraints
): DeterministicResult => {
	const findings: Array<string> = [];
	const bounded = Option.liftThrowable(
		Schema.decodeUnknownSync(Schema.String.check(Schema.isMaxLength(constraints.maxOutputChars)))
	)(output);
	if (Option.isNone(bounded)) {
		return {
			contractValid: false,
			findings: [`output exceeds ${String(constraints.maxOutputChars)} characters`],
			score: 0
		};
	}
	const decoded = decodeBrief(output);
	if (Option.isNone(decoded)) {
		return { contractValid: false, findings: ['output is not a valid design-brief@1 document'], score: 0 };
	}
	const brief: DesignBrief = decoded.value;

	const typesFactor = boundsPenalty(brief.domainTypes.length, constraints.maxDomainTypes, findings, 'domainTypes');
	const modulesFactor = boundsPenalty(brief.modules.length, constraints.maxModules, findings, 'modules');
	const snippetsFactor = boundsPenalty(brief.effectSnippets.length, constraints.maxSnippets, findings, 'effectSnippets');

	const syntaxFindings = brief.effectSnippets.flatMap((snippet) =>
		Syntax.diagnosticsForFile('snippet.ts', snippet.code).map(
			(diagnostic) => `snippet '${snippet.title}': ${diagnostic.kind} at line ${String(diagnostic.line)}`
		)
	);
	findings.push(...syntaxFindings);
	const syntaxFactor =
		brief.effectSnippets.length === 0
			? 1
			: clamp01(1 - syntaxFindings.length / brief.effectSnippets.length);

	const substantsive = clamp01(
		(brief.modules.length > 0 ? 0.25 : 0) +
			(brief.domainTypes.length > 0 ? 0.25 : 0) +
			(brief.effectSnippets.length > 0 ? 0.25 : 0) +
			(brief.decisions.length > 0 ? 0.15 : 0) +
			(brief.risks.length > 0 ? 0.1 : 0)
	);

	const score = clamp01(
		substantsive * typesFactor * modulesFactor * snippetsFactor * syntaxFactor
	);
	return { contractValid: true, findings, score };
};

// ---------------------------------------------------------------------------
// Judge port + scoring composition
// ---------------------------------------------------------------------------

export interface JudgeInput {
	readonly rubric: string;
	readonly output: string;
	readonly dimensions: ReadonlyArray<string>;
}

export namespace Judge {
	export interface Service {
		score(input: JudgeInput): Effect.Effect<Readonly<Record<string, number>>, EvaluatorError>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/benchmark/Judge'
	) {}
}

export interface ScoreBreakdown {
	readonly deterministic: DeterministicResult;
	readonly dimensions: Readonly<Record<string, number>>;
	readonly total: number;
}

const W_DETERMINISTIC = 0.4;
const W_JUDGE = 0.6;

/** Weighted total from deterministic + judge dimension means. Bounded to [0,1]. */
export const composeScore = (
	deterministic: DeterministicResult,
	dimensions: Readonly<Record<string, number>>
): ScoreBreakdown => {
	const values = Object.values(dimensions).filter((value) => Number.isFinite(value) && value >= 0);
	const judgeMean =
		values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
	const total = clamp01(W_DETERMINISTIC * deterministic.score + W_JUDGE * judgeMean);
	return { deterministic, dimensions, total };
};

/**
 * Score one candidate: deterministic checks always run; the judge runs only
 * for contract-valid output (invalid output is deterministically 0).
 */
export const scoreCandidate = (
	output: string,
	input: {
		readonly rubric: string;
		readonly dimensions: ReadonlyArray<string>;
		readonly constraints: TaskConstraints;
	}
): Effect.Effect<ScoreBreakdown, TaskError, Judge.Tag> =>
	Effect.gen(function* () {
		const deterministic = evaluateDesignBrief(output, input.constraints);
		if (!deterministic.contractValid) {
			return composeScore(deterministic, {});
		}
		const judge = yield* Judge.Tag;
		const dimensions = yield* judge
			.score({ rubric: input.rubric, output, dimensions: input.dimensions })
			.pipe(
				Effect.mapError(
					(cause): TaskError =>
						new TaskError({
							operation: 'score',
							reason: `judge unavailable: ${cause.reason}`
						})
				)
			);
		return composeScore(deterministic, dimensions);
	});

// ---------------------------------------------------------------------------
// Leader selection (pure, deterministic)
// ---------------------------------------------------------------------------

export interface ScoredTrialRef {
	readonly trialId: string;
	readonly profileId: string;
	readonly deterministicScore: number;
	readonly total: number;
}

const byLeaderOrder = Order.combineAll([
	Order.mapInput(Order.Number, (ref: ScoredTrialRef) => -ref.total),
	Order.mapInput(Order.Number, (ref: ScoredTrialRef) => -ref.deterministicScore),
	Order.mapInput(Order.String, (ref: ScoredTrialRef) => ref.profileId),
	Order.mapInput(Order.String, (ref: ScoredTrialRef) => ref.trialId)
]);

/**
 * Deterministic winner: max total, tie-break deterministic score desc, then
 * profile id asc, then trial id asc. Returns Option.none for an empty set.
 */
export const selectLeader = (
	scored: ReadonlyArray<ScoredTrialRef>
): Option.Option<ScoredTrialRef> =>
	Option.fromUndefinedOr(
		sort(
			[...scored].filter((ref) => Number.isFinite(ref.total)),
			byLeaderOrder
		)[0]
	);

export const evaluatorFailure = (reason: string): EvaluatorError =>
	new EvaluatorError({ operation: 'evaluate', reason });
