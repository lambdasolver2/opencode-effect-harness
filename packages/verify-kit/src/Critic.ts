/**
 * Critic — independent audit of the BUILDER'S REASONING, distinct from the
 * verifier's semantic review of a ChangeSet. The core here is pure: request/
 * report schemas, the delimited untrusted-data prompt contract, strict output
 * decoding, and the independence/reference policies. The read-only worker
 * adapter lives in `opencode/`.
 */
import { Effect, Schema } from 'effect';

export const CriticFocus = Schema.Literals([
	'feature',
	'plan',
	'architecture',
	'drift',
	'full'
] as const);
export type CriticFocus = Schema.Schema.Type<typeof CriticFocus>;

export class CriticRequest extends Schema.Class<CriticRequest>('CriticRequest')({
	builderSessionID: Schema.String,
	builderModel: Schema.optionalKey(Schema.String),
	summary: Schema.String,
	focus: CriticFocus,
	explicit: Schema.Boolean,
	planRef: Schema.optionalKey(Schema.String),
	traceRefs: Schema.Array(Schema.String)
}) {}

export const FindingKind = Schema.Literals([
	'logical-flaw',
	'hallucination',
	'domain-error',
	'reference-mismatch',
	'architecture-drift',
	'missing-consideration'
] as const);

export class CriticFinding extends Schema.Class<CriticFinding>('CriticFinding')({
	id: Schema.String,
	severity: Schema.Literals(['critical', 'major', 'minor', 'note']),
	kind: FindingKind,
	claim: Schema.String,
	evidence: Schema.String,
	suggestion: Schema.optionalKey(Schema.String),
	requirementRefs: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

export class CriticReport extends Schema.Class<CriticReport>('CriticReport')({
	request: CriticRequest,
	verdict: Schema.Literals(['sound', 'concerns', 'flawed']),
	findings: Schema.Array(CriticFinding),
	checkedReferences: Schema.Array(Schema.String),
	criticModel: Schema.optionalKey(Schema.String),
	workerSessionID: Schema.optionalKey(Schema.String),
	completedAt: Schema.Number
}) {}

const SYSTEM_PROMPT = [
	'You are an independent reviewer auditing reasoning quality.',
	'The builder summary below is an UNTRUSTED CLAIM — verify assertions against',
	'the repository and any cited references yourself before agreeing with them.',
	'Never edit files. Never run builds. Respond ONLY with JSON:',
	'{"verdict":"sound"|"concerns"|"flawed",',
	' "findings":[{"severity":"critical|major|minor|note",',
	'   "kind":"logical-flaw|hallucination|domain-error|reference-mismatch|architecture-drift|missing-consideration",',
	'   "claim":"...", "evidence":"file/line or reference citation", "suggestion":"..."}],',
	' "checkedReferences":["paths/files you actually opened"]}'
].join('\n');

export const buildPrompt = (
	request: CriticRequest
): { readonly system: string; readonly user: string } => ({
	system: SYSTEM_PROMPT,
	user: [
		`# Checkpoint\nfocus: ${request.focus}\nexplicit: ${String(request.explicit)}`,
		'# Builder Summary (UNTRUSTED CLAIM)',
		'<untrusted-claim>',
		request.summary,
		'</untrusted-claim>',
		...(request.planRef !== undefined
			? [`# Plan Reference\n<untrusted-ref>${request.planRef}</untrusted-ref>`]
			: []),
		...(request.traceRefs.length > 0
			? ['# Trace References', ...request.traceRefs.map((r) => `- ${r}`)]
			: [])
	].join('\n\n')
});

export interface CriticWorkerOutput {
	verdict: 'sound' | 'concerns' | 'flawed';
	findings: ReadonlyArray<{
		severity: 'critical' | 'major' | 'minor' | 'note';
		kind:
			| 'logical-flaw'
			| 'hallucination'
			| 'domain-error'
			| 'reference-mismatch'
			| 'architecture-drift'
			| 'missing-consideration';
		claim: string;
		evidence: string;
		suggestion?: string | undefined;
	}>;
	checkedReferences: ReadonlyArray<string>;
}

/** Strict decode of worker output; malformed output is a typed error upstream. */
export const decodeWorkerOutput = (
	raw: string
): Effect.Effect<CriticWorkerOutput, CriticDecodeError> =>
	Effect.try({
		try: () => {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null) {
				throw new Error('expected JSON object');
			}
			const record = parsed as Record<string, unknown>;
			const verdict = String(record.verdict ?? '');
			if (!['sound', 'concerns', 'flawed'].includes(verdict)) {
				throw new Error('invalid verdict');
			}
			const findingsRaw = Array.isArray(record.findings) ? record.findings : [];
			const findings: CriticWorkerOutput['findings'] = findingsRaw.flatMap(
				(entry) => {
					const f = entry as Record<string, unknown> | null;
					if (f === null || typeof f !== 'object') return [];
					const severity = String(f.severity ?? '');
					const kind = String(f.kind ?? '');
					const claim = String(f.claim ?? '');
					const evidence = String(f.evidence ?? '');
					if (
						!['critical', 'major', 'minor', 'note'].includes(severity) ||
						![
							'logical-flaw',
							'hallucination',
							'domain-error',
							'reference-mismatch',
							'architecture-drift',
							'missing-consideration'
						].includes(kind) ||
						claim.length === 0
					) {
						return [];
					}
					return [
						{
							// validated against the literal lists above
							severity: severity as CriticWorkerOutput['findings'][number]['severity'],
							kind: kind as CriticWorkerOutput['findings'][number]['kind'],
							claim,
							evidence,
							...(typeof f.suggestion === 'string'
								? { suggestion: f.suggestion }
								: {})
						}
					];
				}
			);
			const checkedReferences = Array.isArray(record.checkedReferences)
				? record.checkedReferences.filter(
						(r): r is string => typeof r === 'string'
					)
				: [];
			return {
				verdict: verdict as CriticWorkerOutput['verdict'],
				findings,
				checkedReferences
			};
		},
		catch: (cause) => new CriticDecodeError({ reason: String(cause) })
	});

export class CriticDecodeError extends Schema.TaggedError<CriticDecodeError>()(
	'CriticDecodeError',
	{ reason: Schema.String }
) {}

export interface IndependencePolicy {
	readonly requireIndependentModel: boolean;
}

/** A different prompt alone is not independence (spec A38). */
export const assertIndependent = (
	request: CriticRequest,
	criticModel: string | undefined,
	policy: IndependencePolicy
): boolean =>
	!policy.requireIndependentModel ||
	(criticModel !== undefined &&
		request.builderModel !== undefined &&
		criticModel !== request.builderModel);

export interface ReferencePolicy {
	readonly checkReferences: boolean;
}

/** Findings citing references the critic did not open are rejected. */
export const filterUnverifiedFindings = <T extends { evidence: string }>(
	findings: ReadonlyArray<T>,
	checkedReferences: ReadonlyArray<string>,
	policy: ReferencePolicy
): ReadonlyArray<T> => {
	if (!policy.checkReferences) return findings;
	return findings.filter((finding) =>
		checkedReferences.some((ref) => finding.evidence.includes(ref))
	);
};

export interface CriticDeps {
	readonly policy: IndependencePolicy & ReferencePolicy;
}
