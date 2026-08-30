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
import { fnv1aHex } from 'opencode-harness-shared/Hash.ts';
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
// Authoritative asset manifest (AUDIT-002/023/028; hardening F-06)
//
// manifest.tsv rows are `<relative-path>\t<byte-size>\t<fnv1a-hex>` and list
// EVERY shipped file — skill support documents included. The EXACT inventory
// is part of the contract: missing files, size drift, CONTENT drift (same-size
// replacement), duplicate rows, and UNLISTED extra files all fail module
// construction loudly instead of silently shrinking enforcement. Kind counts
// remain SEMANTIC units (a skill = one SKILL.md), not raw row counts. The
// fingerprint is a drift detector, not a cryptographic signature.
// ---------------------------------------------------------------------------

const EXPECTED_COUNTS = {
	patterns: 47,
	skills: 54,
	guidance: 4
} as const;

/** Rows that represent one SEMANTIC unit of a kind (skill = SKILL.md file). */
const unitRowOfKind = (kind: string, rel: string): boolean =>
	kind === 'skills' ? rel.endsWith('/SKILL.md') : true;

interface ManifestRow {
	readonly rel: string;
	readonly size: number;
	readonly hash: string;
}

type ParsedManifest =
	| { readonly ok: true; readonly rows: ReadonlyArray<ManifestRow> }
	| { readonly ok: false; readonly reason: string };

const MANIFEST_HASH_RE = /^[0-9a-f]{8}$/;

const safeManifestRel = (rel: string): boolean =>
	rel.length > 0 &&
	!rel.startsWith('/') &&
	!rel.split('/').includes('..') &&
	!rel.split('/').includes('');

const parseManifestTsv = (raw: string): ParsedManifest => {
	const cells = raw
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => line.split('\t'));
	const malformed = cells.some((parts) => parts.length !== 3);
	if (malformed) {
		return { ok: false, reason: 'malformed manifest row (expected path\\tsize\\thash)' };
	}
	const rows: ReadonlyArray<ManifestRow> = cells.flatMap((parts) => {
		const rel = parts[0] ?? '';
		const size = Number(parts[1] ?? '');
		const hash = parts[2] ?? '';
		return safeManifestRel(rel) &&
			Number.isInteger(size) &&
			size >= 0 &&
			MANIFEST_HASH_RE.test(hash)
			? [{ rel, size, hash }]
			: [];
	});
	if (rows.length !== cells.length) {
		return { ok: false, reason: 'invalid manifest row value(s)' };
	}
	const duplicate = rows.find(
		(row, index) =>
			rows.findIndex((other) => other.rel === row.rel) !== index
	);
	if (duplicate !== undefined) {
		return { ok: false, reason: `duplicate manifest entry ${duplicate.rel}` };
	}
	return { ok: true, rows };
};

/** Verify every shipped asset against manifest.tsv (counts, sizes, hashes, inventory). */
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
		const parsedManifest = parseManifestTsv(rawOpt.value);
		if (!parsedManifest.ok) {
			return { ok: false as const, reason: parsedManifest.reason };
		}
		const rows = parsedManifest.rows;

		const kindCounts: ReadonlyArray<readonly [string, number]> = [
			['patterns', EXPECTED_COUNTS.patterns],
			['skills', EXPECTED_COUNTS.skills],
			['guidance', EXPECTED_COUNTS.guidance]
		];
		const countMismatches = kindCounts.flatMap(([kind, expected]) => {
			const actual = rows.filter(
				(row) => row.rel.startsWith(`${kind}/`) && unitRowOfKind(kind, row.rel)
			).length;
			return actual === expected
				? []
				: [`count ${kind}: manifest ${String(actual)} != required ${String(expected)}`];
		});

		const checked = yield* Effect.forEach(
			rows,
			(row) =>
				Effect.gen(function*() {
					const target = path.join(assetsRoot, row.rel);
					const statOpt = yield* fs.stat(target).pipe(Effect.option);
					if (Option.isNone(statOpt)) {
						return Option.some(`missing ${row.rel}`);
					}
					if (Number(statOpt.value.size) !== row.size) {
						return Option.some(`size-drift ${row.rel}`);
					}
					const contentOpt = yield* fs.readFileString(target).pipe(Effect.option);
					if (Option.isNone(contentOpt)) {
						return Option.some(`unreadable ${row.rel}`);
					}
					return fnv1aHex(contentOpt.value) === row.hash
						? Option.none()
						: Option.some(`content-drift ${row.rel}`);
				}),
			{ concurrency: 8 }
		);
		const fileMismatches = checked.flatMap((o) => (Option.isSome(o) ? [o.value] : []));

		// Inventory diff: every ACTUAL file under the pinned kinds must be listed.
		const walk = (relDir: string): Effect.Effect<ReadonlyArray<string>> =>
			Effect.gen(function*() {
				const entries = yield* fs
					.readDirectory(path.join(assetsRoot, relDir))
					.pipe(
						Effect.catchTag('PlatformError', () =>
							Effect.succeed([] as ReadonlyArray<string>)
						)
					);
				const nested = yield* Effect.forEach(
					entries,
					(entry) =>
						Effect.gen(function*() {
							const rel = `${relDir}/${entry}`;
							const statOpt = yield* fs
								.stat(path.join(assetsRoot, rel))
								.pipe(Effect.option);
							if (Option.isNone(statOpt)) return [] as ReadonlyArray<string>;
							return statOpt.value.type === 'Directory'
								? yield* walk(rel)
								: [rel];
						}),
					{ concurrency: 8 }
				);
				return nested.flat();
			});
		const inventories = yield* Effect.forEach(
			kindCounts.map(([kind]) => kind),
			(kind) => Effect.map(walk(kind), (files): readonly [string, ReadonlyArray<string>] => [kind, files]),
			{ concurrency: 3 }
		);
		const inventoryMismatches = inventories.flatMap(([kind, actualFiles]) => {
			const listed = new Set(
				rows.filter((row) => row.rel.startsWith(`${kind}/`)).map((row) => row.rel)
			);
			return actualFiles
				.filter((rel) => !listed.has(rel))
				.map((rel) => `unlisted asset ${rel}`);
		});

		const allMismatches = [...countMismatches, ...fileMismatches, ...inventoryMismatches];
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
