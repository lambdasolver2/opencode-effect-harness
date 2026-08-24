/**
 * Bend verification module — own skills/patterns catalogs, proving the
 * per-language contract has no TypeScript assumption.
 */
import { Effect } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { Layer } from 'effect'

import { loadPatterns } from 'opencode-harness-kit/Catalog.ts'
import { CheckerSpec } from 'opencode-verify-kit/Checker.ts'
import { ModuleError } from 'opencode-verify-kit/Module.ts'
import type { ProjectContext, VerificationModule } from 'opencode-verify-kit/Module.ts'

const ASSETS_ROOT = new URL('../assets/', import.meta.url).pathname.replace(/\/$/, '')

export interface CreateOptions {
	readonly assetsRoot?: string | undefined
}

export const createModule = (options: CreateOptions = {}): VerificationModule => ({
	id: 'bend',
	languages: ['bend'],
	appliesTo: (filePath: string) => filePath.endsWith('.bend'),
	checkers: (context: ProjectContext) =>
		Effect.succeed([
			new CheckerSpec({
				id: 'bend-typecheck',
				kind: 'typecheck',
				label: 'bend check',
				command: {
					executable: 'bend',
					args: ['check'],
					cwd: context.projectRoot,
					timeoutMs: 60_000,
					maxOutputBytes: 256_000
				}
			})
		]),
	skills: {
		root: `${ASSETS_ROOT}/skills`,
		entries: [
			{ name: 'bend-gen-run', skillFilePath: `${ASSETS_ROOT}/skills/bend-gen-run/SKILL.md` }
		],
		load: (skillName: string) =>
			skillName === 'bend-gen-run'
				? Effect.map(
					Effect.promise(() => import('node:fs')),
					(fs) => fs.readFileSync(`${ASSETS_ROOT}/skills/bend-gen-run/SKILL.md`, 'utf8')
				  )
				: Effect.fail(
					new ModuleError({ moduleId: 'bend', reason: `unknown skill ${skillName}` })
				  )
	},
	patterns: {
		root: `${ASSETS_ROOT}/patterns`,
		detectors: () =>
        loadPatterns(`${ASSETS_ROOT}/patterns`).pipe(
            Effect.catchTag('CatalogError', () => Effect.succeed([])),
            Effect.provide(Layer.mergeAll(NodeFs.layer, NodePath.layer))
        )
	}
})
