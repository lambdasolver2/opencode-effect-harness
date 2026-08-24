/**
 * Environment — isolated workspace per (task, model, trial) so benchmark
 * trials never share mutable state (spec A9/A46).
 */
import { Context, Effect, FileSystem, Layer, Path } from 'effect';

export namespace Env {
	export interface Options {
		readonly root: string;
	}

	export interface Service {
		/** Create an isolated copy of the task fixture; returns its path. */
		readonly create: (
			taskId: string,
			modelLabel: string,
			trial: number
		) => Effect.Effect<string>;
		/** Remove the isolated workspace after scoring. */
		readonly destroy: (dirPath: string) => Effect.Effect<void>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'ox-effect-harness/compound/Env'
	) {}

	export const layer = (options: Options) =>
		Layer.effect(
			Tag,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;

				return Tag.of({
					create: (taskId, modelLabel, trial) =>
						Effect.gen(function*() {
							const dirName = `${taskId}-${modelLabel}-${String(trial)}`.replace(/[^a-zA-Z0-9_-]/g, '-');
							const dest = path.join(options.root, '.workspaces', dirName);
							yield* fs.makeDirectory(dest, { recursive: true }).pipe(Effect.ignore);
							return dest;
						}),
					destroy: (dirPath) =>
						fs.remove(dirPath, { recursive: true }).pipe(Effect.ignore)
				});
			})
		);
}
