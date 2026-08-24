/**
 * ChangeSet — bounded before/after content for reviewed files. The semantic
 * reviewer and the critic receive a redacted, size-capped ChangeSet, never an
 * unbounded repository dump (spec A28).
 */
import { Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';

export class ChangedFile extends Schema.Class<ChangedFile>('ChangedFile')({
	path: Schema.String,
	before: Schema.optionalKey(Schema.String),
	after: Schema.String
}) {}

export class ChangeSet extends Schema.Class<ChangeSet>('ChangeSet')({
	projectRoot: Schema.String,
	files: Schema.Array(ChangedFile),
	truncated: Schema.Boolean
}) {}

const MAX_FILE_BYTES = 32_000;
const MAX_FILES = 40;

export namespace ChangeSetProvider {
	export interface Interface {
		fromPaths(input: {
			readonly projectRoot: string;
			readonly paths: ReadonlyArray<string>;
		}): Effect.Effect<ChangeSet>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/verification/ChangeSet'
	) {}

	/** FileSystem-backed provider with hard byte/file caps. */
	export const layerFileSystem: Layer.Layer<Service, never, FileSystem.FileSystem | Path.Path> =
		Layer.effect(
			Service,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				return Service.of({
					fromPaths: (input) =>
						Effect.gen(function*() {
							const capped = input.paths.slice(0, MAX_FILES);
							const files = yield* Effect.forEach(
								capped,
								(rel) => {
									const abs = path.isAbsolute(rel)
										? rel
										: path.join(input.projectRoot, rel);
									return fs.readFileString(abs).pipe(
										Effect.catchTag('PlatformError', () => Effect.succeed('')),
										Effect.map((after) =>
											new ChangedFile({
												path: rel,
												after: after.slice(0, MAX_FILE_BYTES)
											})
										)
									);
								},
								{ concurrency: 8 }
							);
							return new ChangeSet({
								projectRoot: input.projectRoot,
								files,
								truncated: input.paths.length > MAX_FILES
							});
						})
				});
			})
		);

	/** Pure in-memory provider for tests. */
	export const makeStatic = (files: ReadonlyArray<ChangedFile>): Interface => ({
		fromPaths: (input) =>
			Effect.succeed(
				new ChangeSet({
					projectRoot: input.projectRoot,
					files: [...files],
					truncated: false
				})
			)
	});
}
