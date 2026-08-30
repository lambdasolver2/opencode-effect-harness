import { Effect, FileSystem } from 'effect';

/**
 * Cross-process mutation guard using atomic directory creation. A competing
 * process receives a typed failure instead of racing or overwriting state.
 * The lock is removed on every normal Effect exit; an abandoned lock remains
 * fail-closed and must be investigated rather than silently ignored.
 */
export const withExclusiveDirectoryLock = <A, E>(
	fs: FileSystem.FileSystem,
	lockPath: string,
	effect: Effect.Effect<A, E>,
	onAcquireFailure: () => E
): Effect.Effect<A, E> =>
	Effect.gen(function* () {
		yield* fs.makeDirectory(lockPath).pipe(
			Effect.catchTag('PlatformError', () => Effect.fail(onAcquireFailure()))
		);
		return yield* effect.pipe(
			Effect.ensuring(
				fs.remove(lockPath, { recursive: true }).pipe(Effect.ignore)
			)
		);
	});
