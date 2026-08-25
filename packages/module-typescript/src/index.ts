/**
 * TypeScript verification module — carries the migrated Effect skill/pattern
 * catalog as its knowledge base, loaded from the SAME immutable asset tree
 * the enforcement gate reads. Paths resolve from the caller-supplied assets
 * root, never process-cwd-relative guesses.
 *
 * Construction requires FileSystem/Path so the authoritative asset manifest
 * is verified EAGERLY at plugin startup: any drift (missing/replaced/
 * truncated assets) fails loudly instead of shrinking enforcement silently.
 */
import { Effect, FileSystem, Option, Path } from 'effect';

import { CatalogError, loadPatterns } from 'opencode-harness-kit/Catalog.ts';
import { CommandSpec } from 'opencode-harness-shared';
import { CheckerSpec, Diagnostic } from 'opencode-verify-kit/Checker.ts';
import {
	ModuleError,
	type VerificationModule
} from 'opencode-verify-kit/Module.ts';

const TSC_DIAGNOSTIC_RE =
	/(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g;

export const DEFAULT_ASSETS_ROOT = new URL('../assets/', import.meta.url)
	.pathname
	.replace(/\/$/, '');

export interface CreateOptions {
	readonly assetsRoot?: string | undefined;
}

// ---------------------------------------------------------------------------
// Authoritative asset manifest (AUDIT-002/023/028)
//
// manifest.tsv rows are `<relative-path>\t<byte-size>`. The EXACT inventory is
// part of the contract: any missing, extra, replaced or truncated asset fails
// module construction loudly instead of silently shrinking enforcement.
// ---------------------------------------------------------------------------

const EXPECTED_COUNTS = {
	patterns: 47,
	skills: 53,
	guidance: 4
} as const;

interface ManifestRow {
	readonly rel: string;
	readonly size: number;
}

const parseManifestTsv = (
	raw: string
): ReadonlyArray<ManifestRow> =>
	raw
		.split('\n')
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			const tabIndex = line.lastIndexOf('\t');
			if (tabIndex <= 0) return [];
			const rel = line.slice(0, tabIndex);
			const size = Number(line.slice(tabIndex + 1));
			return Number.isInteger(size) && size >= 0 ? [{ rel, size }] : [];
		});

/** Verify every shipped asset against manifest.tsv (sizes + exact counts). */
export const verifyAssetsManifest = (
	assetsRoot: string
): Effect.Effect<
	{ readonly ok: true } | { readonly ok: false; readonly reason: string },
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const manifestPath = path.join(assetsRoot, 'manifest.tsv');
		const rawOpt = yield* fs.readFileString(manifestPath).pipe(Effect.option);
		if (Option.isNone(rawOpt)) {
			return {
				ok: false as const,
				reason: `manifest missing: ${manifestPath}`
			};
		}
		const rows = parseManifestTsv(rawOpt.value);
		const byKind = (prefix: string): number =>
			rows.filter((row) => row.rel.startsWith(`${prefix}/`)).length;

		const countMismatches = (
			[
				['patterns', byKind('patterns'), EXPECTED_COUNTS.patterns],
				['skills', byKind('skills'), EXPECTED_COUNTS.skills],
				['guidance', byKind('guidance'), EXPECTED_COUNTS.guidance]
			] as const
		).flatMap(([kind, actual, expected]) =>
			actual === expected
				? []
				: [`count ${kind}: manifest ${String(actual)} != required ${String(expected)}`]
		);

		const checked = yield* Effect.forEach(
			rows,
			(row) =>
				Effect.gen(function*() {
					const statOpt = yield* fs.stat(path.join(assetsRoot, row.rel)).pipe(
						Effect.option
					);
					if (Option.isNone(statOpt)) {
						return Option.some(`missing ${row.rel}`);
					}
					return Number(statOpt.value.size) === row.size
						? Option.none()
						: Option.some(`size-drift ${row.rel}`);
				}),
			{ concurrency: 8 }
		);
		const sizeMismatches = checked.flatMap((o) => (Option.isSome(o) ? [o.value] : []));

		const allMismatches = [...countMismatches, ...sizeMismatches];
		if (allMismatches.length > 0) {
			return {
				ok: false as const,
				reason: `asset drift (${String(allMismatches.length)}): ${allMismatches.slice(0, 6).join('; ')}`
			};
		}
		return { ok: true as const };
	});

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

export const createModule = (
	options: CreateOptions = {}
): Effect.Effect<
	VerificationModule,
	CatalogError | InstanceType<typeof ModuleError>,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const assetsRoot = options.assetsRoot ?? DEFAULT_ASSETS_ROOT;
		const patternsDir = path.join(assetsRoot, 'patterns');
		const skillsDir = path.join(assetsRoot, 'skills');

		// Fail LOUDLY on any asset drift before exposing catalogs (AUDIT-002).
		const manifestCheck = yield* verifyAssetsManifest(assetsRoot);
		if (!manifestCheck.ok) {
			return yield* Effect.fail(
				new CatalogError({ path: assetsRoot, reason: manifestCheck.reason })
			);
		}

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
