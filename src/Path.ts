/**
 * RealPath — SECURITY adapter: resolves symlinks so containment checks see
 * the REAL location, not a lexically-contained alias. Node APIs are confined
 * to this single adapter file (AUDIT-035 follow-up); this is a deliberate,
 * justified baseline entry — every other path must stay platform-pure.
 */
import { Effect, Schema } from 'effect';

export class RealPathError extends Schema.TaggedError<RealPathError>()(
	'RealPathError',
	{ path: Schema.String }
) {}

export const realpath = (
	absPath: string
): Effect.Effect<string | undefined> =>
	Effect.tryPromise({
		try: () => import('node:fs/promises').then((mod) => mod.realpath(absPath)),
		catch: () => new RealPathError({ path: absPath })
	}).pipe(
		Effect.catchTag('RealPathError', () => Effect.succeed(undefined))
	);
