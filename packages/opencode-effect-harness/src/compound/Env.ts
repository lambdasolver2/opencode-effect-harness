/**
 * Env — REAL isolated workspaces per (task, model, trial). Each create makes a
 * fresh unique temp directory under the root and optionally copies a task
 * fixture into it; destroy removes it. Trials never share mutable state.
 */
import { Context, Effect, FileSystem, Layer, Path, Ref } from 'effect';

import { InvalidInput } from '../shared/Errors.ts';
const safeSegment = (value: string): boolean =>
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);

const fsExists = (fs: FileSystem.FileSystem, target: string) =>
	fs.exists(target).pipe(
		Effect.catchTag('PlatformError', () => Effect.succeed(false))
	);

export namespace Env {
	export interface Options {
		readonly root: string;
		/** Optional fixture directory copied into every workspace. */
		readonly fixtureDir?: string | undefined;
	}

	export interface Service {
		create(input: {
			readonly taskId: string;
			readonly modelLabel: string;
			readonly trial: number;
		}): Effect.Effect<string, InvalidInput>;
		destroy(dirPath: string): Effect.Effect<void>;
	}

	export class Tag extends Context.Service<Service, Service>()(
		'opencode-effect-harness/compound/Env'
	) {}

	export const layer = (options: Options) =>
		Layer.effect(
			Tag,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const counter = yield* Ref.make(0);

				return Tag.of({
					create: (input) =>
						Effect.gen(function*() {
							if (!safeSegment(input.taskId)) {
								return yield* Effect.fail(
									new InvalidInput({ reason: `invalid taskId ${input.taskId}` })
								);
							}
							const n = yield* Ref.updateAndGet(counter, (value) => value + 1);
							const prefix =
								`${input.taskId}-${input.trial}-${n}-`.replace(
									/[^a-zA-Z0-9_-]/g,
									'-'
								);
							const parent = path.join(options.root, '.workspaces');
							yield* fs.makeDirectory(parent, { recursive: true }).pipe(
								Effect.catchTag('PlatformError', () => Effect.void)
							);
							const workspace = path.join(
								parent,
								`${prefix}${Date.now().toString(36)}`
							);
							yield* fs.makeDirectory(workspace, { recursive: true }).pipe(
								Effect.catchTag('PlatformError', () =>
									Effect.fail(new InvalidInput({ reason: 'workspace create failed' }))
								)
							);
							if (
								options.fixtureDir !== undefined &&
								(yield* fsExists(fs, options.fixtureDir))
							) {
								yield* fs.copy(options.fixtureDir, workspace, { overwrite: true }).pipe(
									Effect.catchTag('PlatformError', () =>
										Effect.fail(new InvalidInput({ reason: 'fixture copy failed' }))
									)
								);
							}
							return workspace;
						}),
					destroy: (dirPath) =>
						fs.remove(dirPath, { recursive: true }).pipe(Effect.ignore)
				});
			})
		);
}
