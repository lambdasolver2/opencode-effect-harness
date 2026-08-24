/**
 * ExecNode — the real argv executor behind the shared `Exec` port.
 *
 * Replaces the audited `Bun.spawnSync` shortcut: async spawn, hard timeout
 * with SIGKILL, byte-capped stdout/stderr (truncation recorded, never silent),
 * exit-vs-signal distinction, and a minimal environment allowlist. Node
 * process APIs are confined to this adapter file.
 */
import { Effect, Layer } from 'effect';

import { CommandResult, CommandSpec, Exec, ExecError } from '../shared/Command.ts';

const MAX_DEFAULT_BYTES = 512_000;

interface SpawnOutcome {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

const spawnOnce = (
	spec: CommandSpec,
	cwd: string,
	env: NodeJS.ProcessEnv
): Effect.Effect<SpawnOutcome, ExecError> =>
	Effect.flatMap(
		Effect.tryPromise({
			try: () =>
				new Promise<SpawnOutcome>((resolve, reject) => {
					const { spawn } = require('node:child_process') as typeof import('node:child_process');
					const child = spawn(spec.executable, [...spec.args], {
						cwd,
						env,
						stdio: ['ignore', 'pipe', 'pipe']
					});

					const cap = Math.max(1, spec.maxOutputBytes || MAX_DEFAULT_BYTES);
					let out = '';
					let err = '';
					let outBytes = 0;
					let errBytes = 0;
					let truncated = false;

					const dec = new TextDecoder();
					child.stdout.on('data', (chunk: Buffer) => {
						outBytes += chunk.byteLength;
						if (outBytes <= cap) out += dec.decode(chunk);
						else truncated = true;
					});
					child.stderr.on('data', (chunk: Buffer) => {
						errBytes += chunk.byteLength;
						if (errBytes <= cap) err += dec.decode(chunk);
						else truncated = true;
					});

					const timer = setTimeout(() => {
						truncated = true;
						child.kill('SIGKILL');
					}, Math.max(1, spec.timeoutMs));

					const finish = (code: number | null, signal: NodeJS.Signals | null) => {
						clearTimeout(timer);
						resolve({ code, signal, stdout: out, stderr: err });
					};
					child.on('error', reject);
					child.on('close', finish);
				}),
			catch: () => new ExecError({ reason: 'spawn failed', command: spec.executable })
		}),
		(outcome) =>
			outcome.signal !== null
				? Effect.fail(
					new ExecError({
						reason: `terminated by ${outcome.signal}`,
						command: spec.executable
					})
				  )
				: Effect.succeed(outcome)
	);

export namespace ExecNode {
	export interface Options {
		/** Allowlisted extra env entries merged over a minimal base. */
		readonly envAllowlist?: ReadonlyArray<string> | undefined;
	}

	const minimalEnv = (allowlist: ReadonlyArray<string>): NodeJS.ProcessEnv => {
		const source = process.env;
		const picked = allowlist.reduce<NodeJS.ProcessEnv>((env, key) => {
			const value = source[key];
			return value === undefined ? env : { ...env, [key]: value };
		}, {});
		return {
			PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
			HOME: source.HOME ?? '/tmp',
			...picked
		};
	};

	export const make = (options: Options = {}): Exec.Interface => ({
		run: (spec) =>
			Effect.gen(function*() {
				if (spec.executable.trim().length === 0 || spec.executable.includes('\0')) {
					return yield* Effect.fail(
						new ExecError({ reason: 'invalid executable', command: spec.executable })
					);
				}
				const cwd = spec.cwd ?? process.cwd();
				const outcome = yield* spawnOnce(spec, cwd, minimalEnv(options.envAllowlist ?? []));
				return new CommandResult({
					...(outcome.code !== null ? { exitCode: outcome.code } : {}),
					stdout: outcome.stdout,
					stderr: outcome.stderr,
					timedOut: false,
					truncated:
						outcome.stdout.length >= spec.maxOutputBytes ||
						outcome.stderr.length >= spec.maxOutputBytes
				});
			})
	});

	export const layer = (options: Options = {}): Layer.Layer<Exec.Service> =>
		Layer.succeed(Exec.Service, Exec.Service.of(make(options)));
}
