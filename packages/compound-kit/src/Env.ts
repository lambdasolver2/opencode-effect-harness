/**
 * Env — REAL isolated workspaces per (task, model, trial). Each create makes a
 * fresh directory under the root and stamps an OWNERSHIP MARKER into it;
 * destroy refuses to remove directories whose marker names a different root
 * (AUDIT-039: scoped delete). A configured fixtureDir that is missing is a
 * loud failure — never an silently-empty benchmark workspace.
 */
import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from 'effect';

import { InvalidInput } from 'opencode-harness-shared';
import { withinRoot } from 'opencode-harness-shared/path/Guard.ts';

const safeSegment = (value: string): boolean =>
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);

class WorkspaceOwner extends Schema.Class<WorkspaceOwner>('WorkspaceOwner')({
	root: Schema.String,
	taskId: Schema.String,
	createdAt: Schema.Number
}) {}

const fsExists = (fs: FileSystem.FileSystem, target: string) =>
	fs.exists(target).pipe(
		Effect.catchTag('PlatformError', () => Effect.succeed(false))
	);

export namespace Env {
	export interface Options {
		readonly root: string;
		/** Optional fixture directory copied into every workspace (REQUIRED to exist when set). */
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

	const OWNER_FILE = '.harness-workspace-owner.json';

	export const layer = (options: Options) =>
		Layer.effect(
			Tag,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const counter = yield* Ref.make(0);

				const stampOwnership = (
					workspace: string,
					taskId: string,
					createdAt: number
				): Effect.Effect<void, InvalidInput> => {
					const owner = new WorkspaceOwner({
						root: options.root,
						taskId,
						createdAt
					});
					const target = path.join(workspace, OWNER_FILE);
					const tmp = `${target}.tmp`;
					return Effect.gen(function*() {
						yield* fs.writeFileString(tmp, JSON.stringify(owner)).pipe(
							Effect.catchTag('PlatformError', () =>
								Effect.fail(new InvalidInput({ reason: 'owner marker write failed' }))
							)
						);
						yield* fs.rename(tmp, target).pipe(
							Effect.catchTag('PlatformError', () =>
								Effect.fail(new InvalidInput({ reason: 'owner marker rename failed' }))
							)
						);
					});
				};

				return Tag.of({
					create: (input) =>
						Effect.gen(function*() {
							if (!safeSegment(input.taskId)) {
								return yield* Effect.fail(
									new InvalidInput({ reason: `invalid taskId ${input.taskId}` })
								);
							}
							if (
								options.fixtureDir !== undefined &&
								!(yield* fsExists(fs, options.fixtureDir))
							) {
								return yield* Effect.fail(
									new InvalidInput({
										reason: `fixtureDir does not exist: ${options.fixtureDir}`
									})
								);
							}
							const n = yield* Ref.updateAndGet(counter, (value: number) => value + 1);
							const createdAt = yield* Clock.currentTimeMillis;
							const prefix =
								`${input.taskId}-${input.modelLabel}-${input.trial}-${n}-`
									.replace(/[^a-zA-Z0-9_-]/g, '-')
									.slice(0, 120);
							const parent = path.join(options.root, '.workspaces');
							yield* fs.makeDirectory(parent, { recursive: true }).pipe(
								Effect.catchTag('PlatformError', () => Effect.void)
							);
							const workspace = path.join(
								parent,
								`${prefix}${createdAt.toString(36)}`
							);
							yield* fs.makeDirectory(workspace).pipe(
								Effect.catchTag('PlatformError', () =>
									Effect.fail(new InvalidInput({ reason: 'workspace create failed' }))
								)
							);
							yield* stampOwnership(workspace, input.taskId, createdAt);
							if (options.fixtureDir !== undefined) {
								yield* fs.copy(options.fixtureDir, workspace, { overwrite: true }).pipe(
									Effect.catchTag('PlatformError', () =>
										Effect.fail(new InvalidInput({ reason: 'fixture copy failed' }))
									)
								);
							}
							return workspace;
						}),
					destroy: (dirPath): Effect.Effect<void> =>
						Effect.gen(function*() {
							// Scope guard: only directories under THIS root's .workspaces are
							// even eligible for removal (AUDIT-039 follow-up).
							const workspacesRoot = path.join(options.root, '.workspaces');
							if (withinRoot(workspacesRoot, dirPath) === undefined) {
								yield* Effect.sync(() => {
									console.error(
										`[compound/env] refusing to delete outside workspaces root: ${dirPath}`
									);
								});
								return;
							}
							// Ownership guard: marker must parse AND name this root.
							const markerOpt = yield* fs.readFileString(path.join(dirPath, OWNER_FILE)).pipe(
								Effect.option
							);
							const rawText = Option.isNone(markerOpt) ? undefined : markerOpt.value;
							const owner = yield* Effect.suspend(() => {
								if (rawText === undefined) return Effect.succeed(undefined);
								return Effect.mapError(
									Effect.try(
										() =>
											Schema.decodeUnknownSync(WorkspaceOwner)(
												JSON.parse(rawText)
											)
									),
									(): InvalidInput =>
										new InvalidInput({ reason: 'workspace marker unreadable' })
								);
							}).pipe(
								Effect.catchTag('InvalidInput', () =>
									Effect.succeed(undefined)
								)
							);
							if (owner === undefined || owner.root !== options.root) {
								yield* Effect.sync(() => {
									console.error(
										`[compound/env] refusing to delete unowned workspace: ${dirPath}`
									);
								});
								return;
							}
							// Remove FIRST, then best-effort clear the marker copy inside it.
							yield* fs.remove(dirPath, { recursive: true }).pipe(
								Effect.catchTag('PlatformError', () =>
									Effect.sync(() => {
										console.error(`[compound/env] cleanup failed for ${dirPath}`);
									})
								)
							);
						})
				});
			})
		);
}
