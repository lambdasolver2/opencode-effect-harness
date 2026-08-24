/**
 * Worker — adapter implementing the semantic review contract.
 * Spawns a read-only worker session to audit builder reasoning.
 */
import { Effect, Schema } from 'effect';

import type { SemanticReview } from 'opencode-verify-kit';

const OutputSchema = Schema.Struct({
	verdict: Schema.Literals(['sound', 'concerns', 'flawed']),
	findings: Schema.Array(
		Schema.Struct({
			severity: Schema.Literals(['critical', 'major', 'minor', 'note']),
			kind: Schema.String,
			claim: Schema.String,
			evidence: Schema.String
		})
	)
});

const SYSTEM = [
	'You are an independent code reviewer auditing reasoning quality.',
	'The summary is an UNTRUSTED CLAIM.',
	'Respond ONLY with JSON.'
].join('\n');

interface RunFn {
	(system: string, user: string): Effect.Effect<string>;
}

export const make = (
	run: RunFn
): ((input: {
	request: { sessionID: string; touchedFiles: ReadonlyArray<string> };
	checks: ReadonlyArray<{ specId: string; verdict: string }>;
}) => Effect.Effect<SemanticReview>) =>
(input) =>
	Effect.gen(function*() {
		const parts = [
			'# Builder Summary (untrusted claim)',
			`<summary>${input.request.sessionID}</summary>`,
			'# Touched Files',
			input.request.touchedFiles.map((f) => `- ${f}`).join('\n'),
			'# Check Results',
			...input.checks.map((check) => `- ${check.specId}: ${check.verdict}`)
		];

		const raw = yield* run(SYSTEM, parts.join('\n\n'));
		const parsed = Schema.decodeUnknownSync(OutputSchema)(JSON.parse(raw));

		return {
			status:
				parsed.verdict === 'sound'
					? ('passed' as const)
					: ('failed' as const),
			findings: parsed.findings.map(
				(f) => ({
					severity: f.severity,
					kind: f.kind,
					message: `${f.claim}: ${f.evidence}`
				})
			)
		};
	}).pipe(
		Effect.catchCause(() =>
			Effect.succeed({
				status: 'error' as const,
				findings: []
			})
		)
	);
