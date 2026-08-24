/**
 * Store — versioned Blueprint persistence with rollback.
 * Heritage: effect-autoagent BlueprintStore, retargeted to append-only
 * markdown modules + JSON lineage state (spec A37).
 */
import { Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';

import type { Blueprint } from './Blueprint.ts';
import { Evolution, Lineage } from './Evolution.ts';

export class Error extends Schema.TaggedError<Error>()('StoreError', {
	operation: Schema.String,
	reason: Schema.String
}) {}

export namespace Store {
	export interface Interface {
		/** Save a new immutable version block; advances the pointer atomically. */
		readonly save: (
			blueprint: Blueprint,
			markdownBlock: string
		) => Effect.Effect<void, Error>;
		/** Read current lineage state (committed versions + attempts). */
		readonly lineage: (
			blueprintId: string
		) => Effect.Effect<Lineage, Error>;
		/** Persist updated lineage after evolution steps. */
		readonly saveLineage: (lineage: Lineage) => Effect.Effect<void, Error>;
		/** Rollback: point `current` back to the previous committed version. */
		readonly rollback: (blueprintId: string) => Effect.Effect<void, Error>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/compound/Store'
	) {}

	export const layer = (baseDir: string) =>
		Layer.effect(
			Service,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;

				const blueprintsDir = path.join(baseDir, 'blueprints');
				const stateDir = path.join(blueprintsDir, 'state');

				const ensureDirs = () =>
					Effect.all([
						fs.makeDirectory(blueprintsDir, { recursive: true }).pipe(Effect.ignore),
						fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore)
					]);

				const lineagePath = (id: string) => path.join(stateDir, `${id}.json`);

				const readLineage = (id: string): Effect.Effect<Lineage, Error> =>
					fs.readFileString(lineagePath(id)).pipe(
						Effect.flatMap((raw) =>
							Effect.try({
								try: () => JSON.parse(raw) as Lineage,
								catch: (cause) =>
									new Error({
										operation: 'readLineage',
										reason: `invalid JSON for ${id}: ${String(cause)}`
									})
							})
						),
						Effect.catchTag('PlatformError', () =>
							Effect.fail(new Error({ operation: 'readLineage', reason: `not found: ${id}` }))
						)
					);

				const saveLineage = (lineage: Lineage): Effect.Effect<void, Error> =>
					ensureDirs().pipe(
						Effect.andThen(
							fs.writeFileString(
								lineagePath(lineage.blueprintId),
								JSON.stringify(lineage, null, 2)
							)
						),
						Effect.mapError((cause) =>
							new Error({ operation: 'saveLineage', reason: String(cause) })
						)
					);

				const decodeLineage = Schema.decodeUnknownSync(Lineage);

				return Service.of({
					save: (blueprint, markdownBlock) =>
						ensureDirs().pipe(
							Effect.andThen(
								fs.writeFileString(
									path.join(blueprintsDir, `${blueprint.id}.md`),
									markdownBlock
								)
							),
							Effect.mapError((cause) =>
								new Error({ operation: 'save', reason: String(cause) })
							)
						),
					lineage: readLineage,
					saveLineage,
					rollback: (id) =>
						Effect.gen(function*() {
							const lineage = yield* readLineage(id);
							if (lineage.committed.length < 2) {
								return; // nothing to roll back to
							}
							const trimmed = new Lineage({
								...lineage,
								committed: lineage.committed.slice(0, -1)
							});
							yield* saveLineage(trimmed);
						})
				});
			})
		);

	export const decodeLineage = Schema.decodeUnknownSync(Lineage);
}
