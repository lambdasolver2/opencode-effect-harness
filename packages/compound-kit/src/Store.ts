/**
 * Store — append-only Blueprint markdown + atomic pointer/lineage state.
 *
 * Fixes over the audited skeleton:
 *  - blueprint ids are slug-validated (no path traversal)
 *  - version blocks are APPENDED to `<id>.md`; existing bytes never rewritten
 *  - lineage state is Schema-DECODED on read and atomically written (tmp+rename)
 *  - the current-best pointer moves via pointer writes; rollback NEVER deletes
 *    committed blocks or history
 *  - per-blueprint semaphore serializes concurrent mutations
 */
import { Context, Effect, FileSystem, Layer, Path, Ref, Schema } from 'effect';
import { Semaphore } from 'effect';

import { Lineage } from './Evolution.ts';
import { withExclusiveDirectoryLock } from 'opencode-harness-shared/ExclusiveLock.ts';

export class Error extends Schema.TaggedError<Error>()('StoreError', {
	operation: Schema.String,
	reason: Schema.String
}) {}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface VersionBlockInput {
	readonly blueprintId: string;
	readonly version: number;
	readonly evaluatorVersion: string;
	readonly score: number;
	readonly baselineTrain: number;
	readonly baselineHoldout: number;
	readonly markdown: string;
	readonly diffSummary: string;
	readonly now: number;
}

export class CurrentPointer extends Schema.Class<CurrentPointer>('CurrentPointer')({
	blueprintId: Schema.String,
	version: Schema.Number,
	updatedAt: Schema.Number
}) {}

const decodeLineage = Schema.decodeUnknownSync(Lineage);
const decodePointer = Schema.decodeUnknownSync(CurrentPointer);

const escapeCell = (value: string): string =>
	value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

const fsExists = (fs: FileSystem.FileSystem, target: string) =>
	fs.exists(target).pipe(
		Effect.catchTag('PlatformError', () => Effect.succeed(false))
	);

const atomicWrite = (
	fs: FileSystem.FileSystem,
	target: string,
	data: string,
	onFail: () => Error
) =>
	Effect.gen(function*() {
		const tmp =
			target + `.tmp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
		yield* fs.writeFileString(tmp, data);
		yield* fs.rename(tmp, target);
	}).pipe(
		Effect.catchTag('PlatformError', () => Effect.fail(onFail()))
	);

export namespace Store {
	export interface Service {
		appendVersion(input: VersionBlockInput): Effect.Effect<void, Error>;
		lineage(blueprintId: string): Effect.Effect<Lineage, Error>;
		saveLineage(lineage: Lineage): Effect.Effect<void, Error>;
		setPointer(input: {
			readonly id: string;
			readonly version: number;
			readonly now: number;
		}): Effect.Effect<void, Error>;
		pointer(id: string): Effect.Effect<CurrentPointer | undefined, Error>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/Store'
	) {}

	const fail = (operation: string, reason: string) =>
		new Error({ operation, reason });

	export const make = (
		baseDir: string
	): Effect.Effect<Service, Error, FileSystem.FileSystem | Path.Path> =>
		Effect.gen(function*() {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const blueprintsDir = path.join(baseDir, 'blueprints');
			const stateDir = path.join(blueprintsDir, 'state');
			const locksDir = path.join(baseDir, '.locks');
			yield* Effect.forEach(
				[baseDir, blueprintsDir, stateDir, locksDir],
				(dir) =>
					fs.makeDirectory(dir, { recursive: true }).pipe(
						Effect.catchTag('PlatformError', () =>
							Effect.fail(fail('init', `cannot create ${dir}`))
						)
					),
				{ concurrency: 1, discard: true }
			);

			const mdPath = (id: string) => path.join(blueprintsDir, `${id}.md`);
			const lineagePath = (id: string) =>
				path.join(stateDir, `${id}.lineage.json`);
			const pointerPath = (id: string) =>
				path.join(stateDir, `${id}.current.json`);

			const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
			const lockFor = (id: string) =>
				Ref.modify(locks, (map) => {
					const existing = map.get(id);
					if (existing !== undefined) return [existing, map] as const;
					const created = Semaphore.makeUnsafe(1);
					return [created, new Map(map).set(id, created)] as const;
				});
			const guarded = <A>(
				id: string,
				effect: Effect.Effect<A, Error>
			): Effect.Effect<A, Error> =>
				Effect.flatMap(lockFor(id), (semaphore) =>
					semaphore.withPermits(1)(
						withExclusiveDirectoryLock(
							fs,
							path.join(locksDir, `${id}.lock`),
							effect,
							() => fail('lock', `another process owns the lock for ${id}`)
						)
					)
				);

			const writePointer = (input: {
				readonly id: string;
				readonly version: number;
				readonly now: number;
			}): Effect.Effect<void, Error> =>
				atomicWrite(
					fs,
					pointerPath(input.id),
					JSON.stringify(
						new CurrentPointer({
							blueprintId: input.id,
							version: input.version,
							updatedAt: input.now
						})
					),
					() => fail('write', `pointer write failed for ${input.id}`)
				);

			const service: Service = {
				appendVersion: (input) => {
					if (!SLUG_RE.test(input.blueprintId)) {
						return Effect.fail(
							fail('appendVersion', `invalid blueprint id ${input.blueprintId}`)
						);
					}
					return guarded(input.blueprintId, Effect.gen(function*() {
						const target = mdPath(input.blueprintId);
						const exists = yield* fs.exists(target).pipe(
							Effect.catchTag('PlatformError', () => Effect.succeed(false))
						);
						const existing = exists
							? yield* fs.readFileString(target).pipe(
									Effect.catchTag('PlatformError', () =>
										Effect.fail(fail('appendVersion', 'existing blueprint is unreadable'))
									)
								)
							: '';
						if (existing.length > 0 && !existing.startsWith('---\n')) {
							return yield* Effect.fail(
								fail(
									'appendVersion',
									'existing file is not an immutable-frontmatter module'
								)
							);
						}
						const header =
							existing.length === 0
								? `---\nid: ${input.blueprintId}\n---\n`
								: existing.endsWith('\n')
									? existing
									: `${existing}\n`;
						const block = [
							'',
							`## Version v${String(input.version)}`,
							'```yaml',
							`evaluatorVersion: ${input.evaluatorVersion}`,
							`score: ${String(input.score)}`,
							`baselineTrain: ${String(input.baselineTrain)}`,
							`baselineHoldout: ${String(input.baselineHoldout)}`,
							`diffSummary: ${escapeCell(input.diffSummary)}`,
							'```',
							'',
							input.markdown,
							''
						].join('\n');
						yield* atomicWrite(
							fs,
							target,
							`${header}${block}`,
							() => fail('appendVersion', 'markdown append failed')
						);
						return yield* writePointer({
							id: input.blueprintId,
							version: input.version,
							now: input.now
						});
					}));
				},

				lineage: (blueprintId) => {
					if (!SLUG_RE.test(blueprintId)) {
						return Effect.fail(fail('lineage', `invalid blueprint id ${blueprintId}`));
					}
					return Effect.gen(function*() {
						const target = lineagePath(blueprintId);
						if (!(yield* fsExists(fs, target))) {
							return yield* Effect.fail(fail('lineage', `not found: ${blueprintId}`));
						}
						const raw = yield* fs.readFileString(target).pipe(
							Effect.catchTag('PlatformError', () =>
								Effect.fail(fail('lineage', 'unreadable lineage'))
							)
						);
						return yield* Effect.try({
							try: () => decodeLineage(JSON.parse(raw)),
							catch: () => fail('lineage', `corrupt lineage for ${blueprintId}`)
						});
					});
				},

				saveLineage: (lineage) => {
					if (!SLUG_RE.test(lineage.blueprintId)) {
						return Effect.fail(
							fail('saveLineage', `invalid blueprint id ${lineage.blueprintId}`)
						);
					}
					return guarded(lineage.blueprintId, Effect.gen(function*() {
						yield* atomicWrite(
							fs,
							lineagePath(lineage.blueprintId),
							JSON.stringify(lineage, null, 2),
							() => fail('saveLineage', 'lineage write failed')
						);
					}));
				},

				setPointer: ({ id, version, now }) => {
					if (!SLUG_RE.test(id)) {
						return Effect.fail(fail('setPointer', `invalid blueprint id ${id}`));
					}
					return guarded(id, Effect.gen(function*() {
						const markdown = yield* fs.readFileString(mdPath(id)).pipe(
							Effect.catchTag('PlatformError', () =>
								Effect.fail(fail('setPointer', `blueprint not found: ${id}`))
							)
						);
						if (!markdown.includes(`## Version v${String(version)}`)) {
							return yield* Effect.fail(
								fail('setPointer', `unknown version ${String(version)} for ${id}`)
							);
						}
						return yield* writePointer({ id, version, now });
					}));
				},

				pointer: (id) => {
					if (!SLUG_RE.test(id)) {
						return Effect.fail(fail('pointer', `invalid blueprint id ${id}`));
					}
					return Effect.gen(function*() {
						const target = pointerPath(id);
						if (!(yield* fsExists(fs, target))) return undefined;
						const raw = yield* fs.readFileString(target).pipe(
							Effect.catchTag('PlatformError', () =>
								Effect.fail(fail('pointer', 'unreadable pointer'))
							)
						);
						return yield* Effect.try({
							try: () => decodePointer(JSON.parse(raw)),
							catch: () => fail('pointer', `corrupt pointer for ${id}`)
						});
					});
				}
			};

			return service;
		});

	export const layer = (
		baseDir: string
	): Layer.Layer<Tag, Error, FileSystem.FileSystem | Path.Path> =>
		Layer.effect(Tag, Effect.map(make(baseDir), (service) => Tag.of(service)));
}
