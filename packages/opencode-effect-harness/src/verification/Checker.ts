/**
 * Checker domain — one deterministic validation step. Commands are argv-only
 * (`shared/Command`) and results preserve raw status alongside parsed
 * diagnostics so a parser bug can never fabricate a pass.
 */
import { Effect, Schema } from 'effect';

import { CommandResult, CommandSpec } from '../shared/Command.ts';

export const Verdict = Schema.Literals([
	'passed',
	'failed',
	'error',
	'skipped'
] as const);
export type Verdict = Schema.Schema.Type<typeof Verdict>;

export const CheckerKind = Schema.Literals([
	'typecheck',
	'test',
	'lint',
	'build',
	'custom'
] as const);
export type CheckerKind = Schema.Schema.Type<typeof CheckerKind>;

export class Diagnostic extends Schema.Class<Diagnostic>('Diagnostic')({
	checkerId: Schema.String,
	severity: Schema.Literals(['error', 'warning', 'info']),
	file: Schema.optionalKey(Schema.String),
	line: Schema.optionalKey(Schema.Number),
	column: Schema.optionalKey(Schema.Number),
	message: Schema.String
}) {}

export class CheckerSpec extends Schema.Class<CheckerSpec>('CheckerSpec')({
	id: Schema.String,
	kind: CheckerKind,
	label: Schema.String,
	command: CommandSpec
}) {}

export class CheckerResult extends Schema.Class<CheckerResult>('CheckerResult')({
	specId: Schema.String,
	kind: CheckerKind,
	label: Schema.String,
	verdict: Verdict,
	exitCode: Schema.optionalKey(Schema.Number),
	timedOut: Schema.optionalKey(Schema.Boolean),
	stdout: Schema.String,
	stderr: Schema.String,
	diagnostics: Schema.Array(Diagnostic),
	durationMs: Schema.Number
}) {}

/** Run one spec through the shared Exec port and classify the outcome. */
export namespace Runner {
	export interface Options {
		readonly parseDiagnostics?: ((spec: CheckerSpec, result: CommandResult) => ReadonlyArray<Diagnostic>) | undefined;
	}

	export const run = Effect.fnUntraced(function* (
		exec: import('../shared/Command.ts').Exec.Interface,
		spec: CheckerSpec,
		options: Options = {}
	) {
		const startedAt = Date.now();
		const commandResult = yield* exec.run(spec.command).pipe(
			Effect.catchTag('ExecError', () =>
				Effect.succeed(
					new CommandResult({
						stdout: '',
						stderr: `executor failure for ${spec.id}`,
						timedOut: true,
						truncated: false
					})
				)
			)
		);
		const diagnostics = options.parseDiagnostics?.(spec, commandResult) ?? [];
		const verdict =
			commandResult.exitCode === undefined && commandResult.timedOut
				? ('error' as const)
				: commandResult.exitCode === 0 && !commandResult.timedOut
					? ('passed' as const)
					: ('failed' as const);
		return new CheckerResult({
			specId: spec.id,
			kind: spec.kind,
			label: spec.label,
			verdict,
			...(commandResult.exitCode !== undefined
				? { exitCode: commandResult.exitCode }
				: {}),
			...(commandResult.timedOut ? { timedOut: true } : {}),
			stdout: commandResult.stdout.slice(0, 8_000),
			stderr: commandResult.stderr.slice(0, 8_000),
			diagnostics: [...diagnostics],
			durationMs: Date.now() - startedAt
		});
	});
}
