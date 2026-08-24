/**
 * Guidance — renders the merged policy header and the gate block reason.
 */
import { Context, Effect, FileSystem, Layer, Path } from 'effect';

import { MIN_EFFECT_SKILLS } from '../Constants.ts';

export namespace Guidance {
	export interface Interface {
		/** Merged guidance docs + policy lines, injected before agent start. */
		readonly header: Effect.Effect<string>;
		/** Human/model-readable reason for blocking a prospective write. */
		readonly reason: (loaded: number) => Effect.Effect<string>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/effect/Guidance'
	) {}

	export const layer = (guidanceDir: string) =>
		Layer.effect(
			Service,
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;

				const entries = yield* fs.readDirectory(guidanceDir).pipe(
					Effect.catchTag(
						'PlatformError',
						() => Effect.succeed([] as ReadonlyArray<string>)
					)
				);
				const bodies = yield* Effect.forEach(
					entries.filter((entry) => entry.endsWith('.md')),
					(entry) => fs.readFileString(path.join(guidanceDir, entry))
				);

				const header = Effect.succeed(
					[
						bodies.join('\n\n'),
						[
							'opencode-effect-harness policy:',
							`- Before planning or writing Effect code, read at least ${MIN_EFFECT_SKILLS} relevant effect-* skills.`,
							'- If any Effect v4 API is unclear, read from the local Effect reference clone instead of guessing.',
							'- Key reference paths:',
							'  - ~/.cache/effect-v4/LLMS.md — generated task-oriented guide',
							'  - ~/.cache/effect-v4/packages/effect/src/ — source of truth'
						].join('\n')
					].join('\n\n')
				);

				return Service.of({
					header,
					reason: (loaded) =>
						Effect.map(header, (policy) =>
							[
								'harness gate: this write introduces Effect code.',
								`Loaded effect-* skills: ${loaded}/${MIN_EFFECT_SKILLS}.`,
								`Read ${Math.max(0, MIN_EFFECT_SKILLS - loaded)} more relevant effect-* skills, then retry.`,
								'Load them with the skill tool (ids start with `effect-`).',
								policy
							].join('\n\n')
						)
				});
			})
		);
}
