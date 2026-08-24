/**
 * Catalog — bundled effect-* skill discovery + read-path matching.
 *
 * Self-discovery of the harness's own bundled skills ensures reads are
 * credited even in child sessions where OpenCode registered no skills.
 */
import { Context, Effect, FileSystem, Layer, Option, Order, Path } from 'effect';
import { sort } from 'effect/Array';

import { Skill } from 'opencode-harness-kit/Skill.ts';

const byName = Order.mapInput(
	Order.String,
	(entry: Skill.Entry) => entry.name
);

const longest = (
	left: Skill.Entry | undefined,
	right: Skill.Entry
): Skill.Entry =>
	left === undefined || right.skillDir.length > left.skillDir.length ? right : left;

const discover = (dir: string) =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const names = yield* fs.readDirectory(dir).pipe(
			Effect.catchTag('PlatformError', () => Effect.succeed([] as ReadonlyArray<string>))
		);
		const options = yield* Effect.forEach(
			names.filter((name) => name.startsWith('effect-')),
			(name) => {
				const skillDir = path.join(dir, name);
				const file = path.join(skillDir, 'SKILL.md');
				return Effect.map(
					Effect.catchCause(fs.exists(file), () => Effect.succeed(false)),
					(exists) =>
						exists
							? Option.some(Skill.entry(name, file, skillDir))
							: Option.none<Skill.Entry>()
				);
			}
		);
		return options.flatMap(Option.match({ onNone: () => [], onSome: (v) => [v] }));
	});

export namespace Catalog {
	export interface Interface {
		readonly entries: Effect.Effect<ReadonlyArray<Skill.Entry>>;
		/** Longest-prefix match of an absolute read path against skill dirs. */
		readonly matchPath: (
			absPath: string
		) => Effect.Effect<Option.Option<Skill.Entry>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/effect/Catalog'
	) {}

	export const layer = (skillsDir: string) =>
		Layer.effect(
			Service,
			Effect.gen(function*() {
				const entries = sort(yield* discover(skillsDir), byName);

				return Service.of({
					entries: Effect.succeed(entries),
					matchPath: (absPath) =>
						Effect.succeed(
							Option.fromUndefinedOr(
								entries.reduce<Skill.Entry | undefined>(
									(best, entry) =>
										absPath !== entry.skillFilePath &&
											!absPath.startsWith(`${entry.skillDir}/`)
											? best
											: longest(best, entry),
									undefined
								)
							)
						)
				});
			})
		);
}
