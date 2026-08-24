/**
 * Clone — maintains a shared user-level shallow clone of the Effect v4
 * source (effect-smol) for authoritative API lookups. Fail-silent.
 */
import { ChildProcess } from 'effect/unstable/process';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import { Context, Effect, FileSystem, Layer, Path } from 'effect';

export namespace Clone {
	export interface Options {
		/** Target directory, e.g. ~/.cache/effect-v4 */
		readonly dir: string;
		readonly repo: string;
	}

	export interface Service {
		/** Ensure the clone exists and is fresh. Never fails outward. */
		readonly ensure: Effect.Effect<boolean>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'ox-effect-harness/effect/Clone'
	) {}

	const git = (args: ReadonlyArray<string>, cwd?: string) =>
		Effect.scoped(
			Effect.flatMap(
				ChildProcess.make('git', [...args], ...(cwd ? [{ cwd }] : [])),
				(handle) => handle.exitCode
			)
		).pipe(Effect.catchCause(() => Effect.succeed(1)));

	export const layer = (options: Options) => (
		spawnerLayer: Layer.Layer<ChildProcessSpawner, never, never>
	) =>
		Layer.effect(
			Tag,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;

				const exists = yield* fs.exists(options.dir).pipe(Effect.catchCause(() => Effect.succeed(false)));

				const ensure: Service['ensure'] = Effect.gen(function*() {
					if (!exists) {
						const tmp = `${options.dir}.cloning`;
						const cloned = yield* git([
							'clone', '--depth', '1', '--single-branch', options.repo, tmp
						]);
						if (cloned !== 0) return false;
						yield* fs.makeDirectory(path.dirname(options.dir), { recursive: true }).pipe(Effect.ignore);
						yield* fs.rename(tmp, options.dir).pipe(Effect.ignore);
						return true;
					}
					const fetched = yield* git(['fetch', '--depth', '1', 'origin'], options.dir);
					if (fetched !== 0) return false;
					return (yield* git(['reset', '--hard', 'origin/HEAD'], options.dir)) === 0;
				}).pipe(
					Effect.catchCause(() => Effect.succeed(false)),
					Effect.provide(spawnerLayer)
				);

				return Tag.of({ ensure });
			})
		);

	export const defaultDir = (home: string): string => `${home}/.cache/effect-v4`;
}
