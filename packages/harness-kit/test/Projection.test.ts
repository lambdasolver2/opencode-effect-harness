/**
 * Regression tests for prospective tool output projection.
 *
 * Policy decisions should be based on the would-be file contents, not a
 * mixed blob of deleted and inserted edit text.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';

import { Edit } from '../src/Edit.ts';
import { Intent } from '../src/Intent.ts';
import {
	projectActualEffect,
	projectProspectiveEffect,
	withTempFile
} from './helpers/kernel.ts';

const contentOf = (projection: {
	readonly content: Option.Option<string>;
}) => Option.getOrElse(projection.content, () => '');

const filePathOf = (projection: {
	readonly filePath: Option.Option<string>;
}) => Option.getOrElse(projection.filePath, () => '');

const editIntent = (
	filePath: string,
	edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string; }>,
	phase: 'before' | 'after' = 'before'
) =>
	new Intent.EditFile({
		phase,
		filePath,
		replacements: edits.map((edit) => new Edit.Value(edit))
	});

const writeIntent = (
	filePath: string,
	content: string,
	phase: 'before' | 'after' = 'before'
) => new Intent.WriteFile({ phase, filePath, content });

describe('Projection.prospective', () => {
	it.live('projects write content exactly as the prospective output', () =>
		Effect.gen(function*() {
			const projection = yield* projectProspectiveEffect(
				process.cwd(),
				writeIntent('src/new-file.ts', 'export const value = 1;\n')
			);

			expect(filePathOf(projection)).toBe('src/new-file.ts');
			expect(contentOf(projection)).toBe('export const value = 1;\n');
		}));

	it.live('reconstructs single-edit output from the current file contents', () =>
		withTempFile(
			'opencode-harness-kit-',
			'src/thing.ts',
			'export const value = 1;\n',
			({ cwd }) =>
				Effect.gen(function*() {
					const projection = yield* projectProspectiveEffect(
						cwd,
						editIntent('src/thing.ts', [
							{ oldText: 'value = 1', newText: 'value = 2' }
						])
					);
					expect(contentOf(projection)).toBe('export const value = 2;\n');
				})
		));

	it.live('falls back to concatenated newText when oldText is ambiguous', () =>
		withTempFile(
			'opencode-harness-kit-',
			'src/dupe.ts',
			'const a = f();\nconst b = f();\n',
			({ cwd }) =>
				Effect.gen(function*() {
					const projection = yield* projectProspectiveEffect(
						cwd,
						editIntent('src/dupe.ts', [
							{ oldText: 'f();', newText: 'g();' }
						])
					);
					// ambiguous match -> fallback content is the inserted text
					expect(contentOf(projection)).toBe('g();');
				})
		));

	it.live('reports no changed spans for deletion-only edits', () =>
		withTempFile(
			'opencode-harness-kit-',
			'src/deleteme.ts',
			'export const gone = 1;\n',
			({ cwd }) =>
				Effect.gen(function*() {
					const projection = yield* projectProspectiveEffect(
						cwd,
						editIntent('src/deleteme.ts', [
							{ oldText: 'export const gone = 1;\n', newText: '' }
						])
					);
					expect(contentOf(projection)).toBe('');
					const spans = Array.from(projection.changedSpans.pipe(Option.match({
						onSome: (s) => s,
						onNone: () => []
					})));
					expect(spans).toHaveLength(0);
				})
		));
});

describe('Projection.actual', () => {
	it.live('reads the final file from disk and locates changed spans', () =>
		withTempFile(
			'opencode-harness-kit-',
			'src/final.ts',
			'export const after = 42;\n',
			({ cwd }) =>
				Effect.gen(function*() {
					const projection = yield* projectActualEffect(
						cwd,
						writeIntent(
							'src/final.ts',
							'ignored-before-content',
							'after'
						)
					);
					expect(contentOf(projection)).toBe('export const after = 42;\n');
				})
		));

	it.live('actual falls back to prospective when the file does not exist', () =>
		Effect.gen(function*() {
			const projection = yield* projectActualEffect(
				process.cwd(),
				writeIntent(
					'definitely/not/here.ts',
					'export const projected = true;',
					'after'
				)
			);
			expect(contentOf(projection)).toBe('export const projected = true;');
		}));
});
