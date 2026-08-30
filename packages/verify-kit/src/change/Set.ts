/**
 * ChangeSet — bounded before/after content for reviewed files. The semantic
 * reviewer and the critic receive a redacted, size-capped ChangeSet, never an
 * unbounded repository dump (spec A28).
 */
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';

import { withinRoot } from 'opencode-harness-shared/path/Guard.ts';

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

/** Hard bounds, exported so hosts can build equivalent hardened providers. */
export const CHANGE_SET_BOUNDS = {
	maxFiles: MAX_FILES,
	maxFileBytes: MAX_FILE_BYTES
} as const;

/**
 * Bounded ChangeSet construction over ANY reader (F-08): the host supplies a
 * containment-hardened read (realpath-resolved) and this core applies the
 * file-count / byte caps and the out-of-root drop accounting. Out-of-root
 * paths are DROPPED and reflected in `truncated`.
 */
export const boundedFromReader = Effect.fn("boundedFromReader")(
	function* (
	input: {
		readonly projectRoot: string;
		readonly paths: ReadonlyArray<string>;
	},
	readFileString: (absolutePath: string) => Effect.Effect<Option.Option<string>>
	) {
		const capped = input.paths.slice(0, MAX_FILES);
		const contained = capped.flatMap((rel) => {
			const absolute = withinRoot(input.projectRoot, rel);
			return absolute === undefined ? [] : [{ rel, absolute }];
		});
		const droppedOutside = capped.length - contained.length;
		const files = yield* Effect.forEach(
			contained,
			(file) =>
				Effect.map(readFileString(file.absolute), (content) =>
					new ChangedFile({
						path: file.rel,
						after: (Option.isSome(content) ? content.value : '').slice(0, MAX_FILE_BYTES)
					})
				),
			{ concurrency: 8 }
		);
		return new ChangeSet({
			projectRoot: input.projectRoot,
			files,
			truncated:
				input.paths.length > MAX_FILES || droppedOutside > 0
		});
	}
);

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

	const serviceFromFileSystem = (fs: FileSystem.FileSystem): Interface =>
		Service.of({
			fromPaths: (input) =>
				boundedFromReader(input, (absolutePath) =>
					fs.readFileString(absolutePath).pipe(Effect.option)
				)
		});

	/** FileSystem-backed provider with hard byte/file caps. */
	export const layerFileSystem: Layer.Layer<Service, never, FileSystem.FileSystem> =
		Layer.effect(Service, Effect.map(FileSystem.FileSystem, serviceFromFileSystem));

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
