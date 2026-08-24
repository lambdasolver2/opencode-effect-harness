/**
 * Bend verification module — proves the VerificationModule contract is
 * language-agnostic. It ships its OWN (empty) catalogs; no TypeScript
 * assumption exists anywhere in the verification core.
 */
import { Effect } from 'effect';

import { CommandSpec } from '../../shared/Command.ts';
import { CheckerSpec } from '../Checker.ts';
import { ModuleError, type ProjectContext, type VerificationModule } from '../Module.ts';

export const bendModule = (): VerificationModule => ({
	id: 'bend',
	languages: ['bend'],
	appliesTo: (filePath) => filePath.endsWith('.bend'),
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
		root: '',
		entries: [],
		load: (name) =>
			Effect.fail(
				new ModuleError({ moduleId: 'bend', reason: `no skill catalog for ${name}` })
			)
	},
	patterns: {
		root: '',
		detectors: () => Effect.succeed([])
	}
});
