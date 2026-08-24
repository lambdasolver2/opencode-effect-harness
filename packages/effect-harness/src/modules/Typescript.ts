/**
 * TypeScript verification module — carries the migrated Effect skill catalog
 * (53 skills / 46 patterns) as its knowledge base.
 */
import { Effect } from 'effect';

const skillsDir = 'packages/effect-harness/skills';
const patternsDir = 'packages/effect-harness/patterns';

export const typescriptModule = {
	id: 'typescript',
	languages: ['ts', 'tsx'],
	appliesTo: (filePath: string) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'),
	checkers: (context: { projectRoot: string; touchedFiles: ReadonlyArray<string> }) =>
		Effect.succeed([
			{
				id: 'ts-typecheck',
				kind: 'typecheck' as const,
				label: 'tsc --noEmit',
				command: {
					executable: 'bunx',
					args: ['tsc', '--noEmit'],
					cwd: context.projectRoot,
					timeoutMs: 120_000,
					maxOutputBytes: 512_000
				}
			}
		]),
	parseDiagnostics: (
		spec: { id: string },
		output: { stderr: string; stdout: string }
	) => {
		const results: Array<{
			checkerId: string;
			severity: 'error';
			file?: string;
			line?: number;
			column?: number;
			message: string;
		}> = [];

		for (const match of output.stderr.matchAll(
			/(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g
		)) {
			const [, file, line, col, code, msg] = match;
			if (file !== undefined && line !== undefined && code !== undefined && msg !== undefined) {
				results.push({
					checkerId: spec.id,
					severity: 'error',
					file,
					line: Number(line),
					column: Number(col),
					message: `${code}: ${msg}`
				});
			}
		}

		return results;
	},
	skills: {
		root: `packages/effect-harness/${skillsDir}`,
		skillCount: 53,
		minRequired: 4,
		manifest: {
			source: 'Effect skill catalog',
			contentHash: '',
			skillCount: 53
		},
		load: (name: string) =>
			Effect.gen(function*() {
				const fs = yield* Effect.promise(() => import('node:fs'));
				return fs.readFileSync(`${skillsDir}/${name}/SKILL.md`, 'utf8').slice(0, 8000);
			}).pipe(Effect.ignore)
	},
	patterns: {
		root: patternsDir,
		patternCount: 46
	}
};
