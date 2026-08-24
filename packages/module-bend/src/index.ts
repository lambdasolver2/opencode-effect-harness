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
import { Effect, FileSystem, Path } from 'effect'
import type { CatalogError } from 'opencode-harness-kit/Catalog.ts'
import { loadPatterns } from 'opencode-harness-kit/Catalog.ts'
import { CommandSpec } from 'opencode-harness-shared'
import { CheckerSpec } from 'opencode-verify-kit/Checker.ts'
import {
	ModuleError,
	type ProjectContext,
	type VerificationModule
} from 'opencode-verify-kit/Module.ts'

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
