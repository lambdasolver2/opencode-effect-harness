/**
 * Command domain — the ONE argv-only process contract used by the verifier,
 * acceptance checks, and internal git operations. Shell strings are never
 * accepted; environment inheritance is an explicit allowlist decision made by
 * the executor implementation.
 */
import { Context, Effect, Schema } from 'effect';

export class CommandSpec extends Schema.Class<CommandSpec>('CommandSpec')({
	executable: Schema.NonEmptyString,
	args: Schema.Array(Schema.String),
	cwd: Schema.optionalKey(Schema.NonEmptyString),
	timeoutMs: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	maxOutputBytes: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}) {}

export class CommandResult extends Schema.Class<CommandResult>('CommandResult')({
	exitCode: Schema.optionalKey(Schema.Number),
	stdout: Schema.String,
	stderr: Schema.String,
	timedOut: Schema.Boolean,
	truncated: Schema.Boolean
}) {}

export const succeeded = (result: CommandResult): boolean =>
	result.exitCode === 0 && !result.timedOut;

export class ExecError extends Schema.TaggedError<ExecError>()('ExecError', {
	reason: Schema.String,
	command: Schema.String
}) {}

export namespace Exec {
	export interface Interface {
		readonly run: (spec: CommandSpec) => Effect.Effect<CommandResult, ExecError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/shared/Exec'
	) {}
}
