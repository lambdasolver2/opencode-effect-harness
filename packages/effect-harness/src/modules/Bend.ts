/**
 * Bend verification module — proves the VerificationModule contract is
 * language-agnostic.
 */

export const bendModule = {
	id: 'bend',
	languages: ['bend'],
	appliesTo: (filePath: string) => filePath.endsWith('.bend'),
	checkers: (_context: { projectRoot: string; touchedFiles: ReadonlyArray<string> }) =>
		Effect.succeed([
			{
				id: 'bend-typecheck',
				kind: 'typecheck' as const,
				label: 'bend check',
				command: {
					executable: 'bend',
					args: ['check'],
					timeoutMs: 60_000,
					maxOutputBytes: 256_000
				}
			}
		])
};

import { Effect } from 'effect';
