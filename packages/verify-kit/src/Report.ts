/**
 * Report domain — every verification run preserves INDEPENDENT components.
 * `overall` is derived by a pure policy that never relabels a skipped review
 * as passed, never hides an error, and never implies semantic review happened
 * when only deterministic checks ran (spec A5).
 */
import { Schema } from 'effect';

import type { CheckerResult } from './Checker.ts';
import { CheckerKind } from './Checker.ts';
import { Diagnostic } from './Checker.ts';
import { SkillEvidence } from './Evidence.ts';

export class PatternFinding extends Schema.Class<PatternFinding>('PatternFinding')({
	patternName: Schema.String,
	level: Schema.Literals(['critical', 'high', 'medium', 'warning', 'info']),
	file: Schema.String,
	line: Schema.Number,
	snippet: Schema.String,
	guidance: Schema.String,
	suggestedSkills: Schema.Array(Schema.String)
}) {}

export class ReviewFinding extends Schema.Class<ReviewFinding>('ReviewFinding')({
	severity: Schema.Literals(['critical', 'major', 'minor', 'note']),
	kind: Schema.String,
	claim: Schema.String,
	evidence: Schema.String,
	suggestion: Schema.optionalKey(Schema.String)
}) {}

export class SemanticReview extends Schema.Class<SemanticReview>('SemanticReview')({
	status: Schema.Literals(['passed', 'failed', 'error', 'skipped']),
	findings: Schema.Array(ReviewFinding),
	workerSessionID: Schema.optionalKey(Schema.String)
}) {}

export const skippedSemanticReview = (): SemanticReview =>
	new SemanticReview({ status: 'skipped', findings: [] });

export const errorSemanticReview = (reason: string): SemanticReview =>
	new SemanticReview({
		status: 'error',
		findings: [
			new ReviewFinding({
				severity: 'major',
				kind: 'review-error',
				claim: 'semantic review could not complete',
				evidence: reason
			})
		]
	});

export const Trigger = Schema.Literals(['manual', 'auto', 'command'] as const);

export class VerifyRequest extends Schema.Class<VerifyRequest>('VerifyRequest')({
	sessionID: Schema.String,
	projectKey: Schema.String,
	projectRoot: Schema.String,
	touchedFiles: Schema.Array(Schema.String),
	trigger: Trigger,
	loadedSkills: Schema.Array(Schema.String),
	minSkillEvidence: Schema.Number
}) {}

export class VerifierReport extends Schema.Class<VerifierReport>('VerifierReport')({
	request: VerifyRequest,
	checks: Schema.Array(
		Schema.Struct({
			specId: Schema.String,
			kind: CheckerKind,
			label: Schema.String,
			verdict: Schema.Literals(['passed', 'failed', 'error', 'skipped']),
			durationMs: Schema.Number,
			diagnostics: Schema.Array(Diagnostic)
		})
	),
	patternFindings: Schema.Array(PatternFinding),
	/** Explicit visibility: pattern scanning was complete, degraded, or off. */
	patternScanStatus: Schema.optionalKey(
		Schema.Literals(['ok', 'error', 'skipped'])
	),
	patternScanError: Schema.optionalKey(Schema.String),
	skillEvidence: SkillEvidence,
	semantic: SemanticReview,
	overall: Schema.Literals(['passed', 'failed', 'error'])
}) {}

export interface OverallInput {
	readonly checks: ReadonlyArray<Pick<CheckerResult, 'verdict'>>;
	readonly skillEvidence: Pick<SkillEvidence, 'status'>;
	readonly semantic: Pick<SemanticReview, 'status'>;
}

export const overall = (input: OverallInput): 'passed' | 'failed' | 'error' => {
	// An EMPTY run verified nothing and must never be reported green.
	if (input.checks.length === 0) return 'error';
	if (input.checks.some((c) => c.verdict === 'error')) return 'error';
	if (input.checks.some((c) => c.verdict === 'failed')) return 'failed';
	if (input.skillEvidence.status === 'insufficient') return 'failed';
	if (input.semantic.status === 'failed') return 'failed';
	if (input.semantic.status === 'error') return 'error';
	return 'passed';
};
