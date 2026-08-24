/**
 * TypeScript verification module — carries the migrated Effect skill/pattern
 * catalog (53 skills / 46 patterns) as its knowledge base, loaded from the
 * SAME immutable asset tree the enforcement gate reads. Paths resolve from the
 * caller-supplied assets root, never process-cwd-relative guesses.
 *
 * Construction requires FileSystem/Path so catalogs are validated eagerly at
 * plugin startup instead of failing silently on first use.
 */
import { Effect, FileSystem, Path } from 'effect';

import { type CatalogError, loadPatterns } from 'opencode-harness-kit/Catalog.ts';
import { CommandSpec } from 'opencode-harness-shared';
import { CheckerSpec, Diagnostic } from 'opencode-verify-kit/Checker.ts';
import {
	ModuleError,
	type VerificationModule
} from 'opencode-verify-kit/Module.ts';

const TSC_DIAGNOSTIC_RE =
	/(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g;

const DEFAULT_ROOT = new URL('../assets/', import.meta.url).pathname.replace(/\/$/, '');

export const createModule = (
	assetsRoot: string = DEFAULT_ROOT
): Effect.Effect<
	VerificationModule,
	CatalogError | InstanceType<typeof ModuleError>,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const patternsDir = path.join(assetsRoot, 'patterns');
		const skillsDir = path.join(assetsRoot, 'skills');

		const detectorList = yield* loadPatterns(patternsDir);

		const names = yield* fs.readDirectory(skillsDir).pipe(
			Effect.catchTag('PlatformError', () => Effect.succeed([] as ReadonlyArray<string>))
		);
		const skillFile = (name: string) => path.join(skillsDir, name, 'SKILL.md');
		const presentSkills = (yield* Effect.forEach(names.filter((n) => n.startsWith('effect-')), (name) =>
			fs.exists(skillFile(name)).pipe(
				Effect.catchTag('PlatformError', () => Effect.succeed(false)),
				Effect.map((exists) => (exists ? [{ name, path: skillFile(name) }] : []))
			)
		)).flat();

		return {
			id: 'typescript',
			languages: ['ts', 'tsx'],
			appliesTo: (filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'),
			checkers: (context) =>
				Effect.succeed([
					new CheckerSpec({
						id: 'ts-typecheck',
						kind: 'typecheck',
						label: 'tsc --noEmit',
						command: new CommandSpec({
							executable: 'bunx',
							args: ['tsc', '--noEmit'],
							cwd: context.projectRoot,
							timeoutMs: 120_000,
							maxOutputBytes: 512_000
						})
					})
				]),
			parseDiagnostics: (spec, result) =>
				[...result.stderr.matchAll(TSC_DIAGNOSTIC_RE)].flatMap((match) => {
					const [, file, line, column, code, message] = match;
					if (
						file === undefined ||
						line === undefined ||
						column === undefined ||
						code === undefined ||
						message === undefined
					) {
						return [];
					}
					return [
						new Diagnostic({
							checkerId: spec.id,
							severity: 'error',
							file,
							line: Number(line),
							column: Number(column),
							message: `${code}: ${message}`
						})
					];
				}),
			skills: {
				root: skillsDir,
				entries: presentSkills.map((entry) => ({
					name: entry.name,
					skillFilePath: entry.path
				})),
				load: (name) => {
					const entry = presentSkills.find((candidate) => candidate.name === name);
					if (entry === undefined) {
						return Effect.fail(
							new ModuleError({ moduleId: 'typescript', reason: `unknown skill ${name}` })
						);
					}
					return fs.readFileString(entry.path).pipe(
						Effect.map((body) => body.slice(0, 16_000)),
						Effect.catchTag('PlatformError', () =>
							Effect.fail(
								new ModuleError({ moduleId: 'typescript', reason: `unreadable ${name}` })
							)
						)
					);
				}
			},
			patterns: {
				root: patternsDir,
				detectors: () => Effect.succeed(detectorList)
			}
		} satisfies VerificationModule;
	});

