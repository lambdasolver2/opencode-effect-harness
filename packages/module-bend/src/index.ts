/**
 * Bend verification module — own skills/patterns catalogs, proving the
 * per-language contract has no TypeScript assumption.
 *
 * Factory contract is UNIFORM across modules (AUDIT-034):
 *   createModule(options?: { assetsRoot?: string }) -> Effect requiring
 *   FileSystem + Path, resolved by the caller's platform layer.
 * Catalog failure is a typed error surfaced at startup — never an empty
 * detector list (AUDIT-028/040). No node:fs access anywhere.
 */
import { Effect, FileSystem, Option, Path } from 'effect'
import { CatalogError, loadPatterns } from 'opencode-harness-kit/Catalog.ts'
import { fnv1aHex } from 'opencode-harness-shared/Hash.ts'
import { CommandSpec } from 'opencode-harness-shared'
import { CheckerSpec } from 'opencode-verify-kit/Checker.ts'
import {
	ModuleError,
	type ProjectContext,
	type VerificationModule
} from 'opencode-verify-kit/Module.ts'

const EXPECTED_COUNTS = { patterns: 1, skills: 1, guidance: 0 } as const
const unitRowOfKind = (kind: string, rel: string): boolean =>
	kind === 'skills' ? rel.endsWith('/SKILL.md') : true
interface ManifestRow { readonly rel: string; readonly size: number; readonly hash: string }
type ParsedManifest = { readonly ok: true; readonly rows: ReadonlyArray<ManifestRow> } | { readonly ok: false; readonly reason: string }
const MANIFEST_HASH_RE = /^[0-9a-f]{8}$/
const safeManifestRel = (rel: string): boolean =>
	rel.length > 0 && !rel.startsWith('/') && !rel.split('/').includes('..') && !rel.split('/').includes('')
const parseManifestTsv = (raw: string): ParsedManifest => {
	const cells = raw.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'))
	if (cells.some((p) => p.length !== 3)) return { ok: false, reason: 'malformed manifest row' }
	const rows: ReadonlyArray<ManifestRow> = cells.flatMap((parts) => {
		const rel = parts[0] ?? ''; const size = Number(parts[1] ?? ''); const hash = parts[2] ?? ''
		return safeManifestRel(rel) && Number.isInteger(size) && size >= 0 && MANIFEST_HASH_RE.test(hash) ? [{ rel, size, hash }] : []
	})
	if (rows.length !== cells.length) return { ok: false, reason: 'invalid manifest row value(s)' }
	const dup = rows.find((r, i) => rows.findIndex((o) => o.rel === r.rel) !== i)
	if (dup !== undefined) return { ok: false, reason: `duplicate manifest entry ${dup.rel}` }
	return { ok: true, rows }
}
const verifyAssetsManifest = (assetsRoot: string): Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly reason: string }, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem; const path = yield* Path.Path
		const manifestPath = path.join(assetsRoot, 'manifest.tsv')
		const rawOpt = yield* fs.readFileString(manifestPath).pipe(Effect.option)
		if (Option.isNone(rawOpt)) return { ok: false as const, reason: `manifest missing: ${manifestPath}` }
		const parsed = parseManifestTsv(rawOpt.value); if (!parsed.ok) return { ok: false as const, reason: parsed.reason }
		const rows = parsed.rows
		const kindCounts: ReadonlyArray<readonly [string, number]> = [['patterns', EXPECTED_COUNTS.patterns], ['skills', EXPECTED_COUNTS.skills], ['guidance', EXPECTED_COUNTS.guidance]]
		const countMismatches = kindCounts.flatMap(([kind, expected]) => {
			const actual = rows.filter((r) => r.rel.startsWith(`${kind}/`) && unitRowOfKind(kind, r.rel)).length
			return actual === expected ? [] : [`count ${kind}: manifest ${String(actual)} != required ${String(expected)}`]
		})
		const checked = yield* Effect.forEach(rows, (row) => Effect.gen(function*() {
			const target = path.join(assetsRoot, row.rel)
			const statOpt = yield* fs.stat(target).pipe(Effect.option)
			if (Option.isNone(statOpt)) return Option.some(`missing ${row.rel}`)
			if (Number(statOpt.value.size) !== row.size) return Option.some(`size-drift ${row.rel}`)
			const contentOpt = yield* fs.readFileString(target).pipe(Effect.option)
			if (Option.isNone(contentOpt)) return Option.some(`unreadable ${row.rel}`)
			return fnv1aHex(contentOpt.value) === row.hash ? Option.none() : Option.some(`content-drift ${row.rel}`)
		}), { concurrency: 8 })
		const fileMismatches = checked.flatMap((o) => (Option.isSome(o) ? [o.value] : []))
		const walk = (relDir: string): Effect.Effect<ReadonlyArray<string>> => Effect.gen(function*() {
			const entries = yield* fs.readDirectory(path.join(assetsRoot, relDir)).pipe(Effect.catchTag('PlatformError', () => Effect.succeed([] as ReadonlyArray<string>)))
			const nested = yield* Effect.forEach(entries, (entry) => Effect.gen(function*() {
				const rel = `${relDir}/${entry}`; const statOpt = yield* fs.stat(path.join(assetsRoot, rel)).pipe(Effect.option)
				if (Option.isNone(statOpt)) return [] as ReadonlyArray<string>
				return statOpt.value.type === 'Directory' ? yield* walk(rel) : [rel]
			}), { concurrency: 8 })
			return nested.flat()
		})
		const inventories = yield* Effect.forEach(kindCounts.map(([k]) => k), (kind) => Effect.map(walk(kind), (files): readonly [string, ReadonlyArray<string>] => [kind, files]), { concurrency: 3 })
		const inventoryMismatches = inventories.flatMap(([kind, actualFiles]) => {
			const listed = new Set(rows.filter((r) => r.rel.startsWith(`${kind}/`)).map((r) => r.rel))
			return actualFiles.filter((rel) => !listed.has(rel)).map((rel) => `unlisted asset ${rel}`)
		})
		const all = [...countMismatches, ...fileMismatches, ...inventoryMismatches]
		return all.length > 0 ? { ok: false as const, reason: `asset drift (${String(all.length)}): ${all.slice(0, 6).join('; ')}` } : { ok: true as const }
	})

export const DEFAULT_ASSETS_ROOT = new URL('../assets/', import.meta.url)
	.pathname
	.replace(/\/$/, '')

export interface CreateOptions {
	readonly assetsRoot?: string | undefined
}

export const createModule = (
	options: CreateOptions = {}
): Effect.Effect<
	VerificationModule,
	CatalogError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const assetsRoot = options.assetsRoot ?? DEFAULT_ASSETS_ROOT
		const skillsDir = path.join(assetsRoot, 'skills')
		const patternsDir = path.join(assetsRoot, 'patterns')
		const manifestCheck = yield* verifyAssetsManifest(assetsRoot)
		if (!manifestCheck.ok) return yield* Effect.fail(new CatalogError({ path: assetsRoot, reason: manifestCheck.reason }))

		const detectors = yield* loadPatterns(patternsDir)
		const skillPath = path.join(skillsDir, 'bend-gen-run', 'SKILL.md')

		return {
			id: 'bend',
			languages: ['bend'],
			appliesTo: (filePath: string) => filePath.endsWith('.bend'),
			checkers: (context: ProjectContext) =>
				Effect.succeed([
					new CheckerSpec({
						id: 'bend-typecheck',
						kind: 'typecheck',
						label: 'bend check',
						command: new CommandSpec({
							executable: 'bend',
							args: ['check'],
							cwd: context.projectRoot,
							timeoutMs: 60_000,
							maxOutputBytes: 256_000
						})
					})
				]),
			skills: {
				root: skillsDir,
				entries: [{ name: 'bend-gen-run', skillFilePath: skillPath }],
				load: (skillName: string) =>
					skillName === 'bend-gen-run'
						? fs.readFileString(skillPath).pipe(
							Effect.catchTag('PlatformError', () =>
								Effect.fail(
									new ModuleError({
										moduleId: 'bend',
										reason: `unreadable ${skillName}`
									})
								)
							)
						  )
						: Effect.fail(
							new ModuleError({
								moduleId: 'bend',
								reason: `unknown skill ${skillName}`
							})
						  )
			},
			patterns: {
				root: patternsDir,
				detectors: () => Effect.succeed(detectors)
			}
		} satisfies VerificationModule
	})
