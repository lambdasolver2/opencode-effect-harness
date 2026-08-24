/**
 * PatternMatcher tests: regex detectors skip string/comment content unless
 * matchInComments is set; AST detectors honor glob filters; changed-span
 * filtering restricts matches to edited regions.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';

import {
	findPatternMatches,
	stripComments
} from '../src/kernel/services/Matcher.ts';
import { Input } from '../src/kernel/Input.ts';
import { Pattern } from '../src/Pattern.ts';

const regexPattern = (options: {
	readonly name: string;
	readonly pattern: string;
	readonly matchInComments?: boolean;
	readonly glob?: string;
}): Pattern.Value =>
	new Pattern.Value({
		name: options.name,
		description: 'test',
		event: 'after',
		toolRegex: '(write|edit)',
		level: 'warning',
		...(options.glob === undefined
			? {}
			: { glob: options.glob }),
		detector: new Pattern.RegexDetector({
			pattern: options.pattern,
			matchInComments: options.matchInComments ?? false
		}),
		guidance: 'guidance',
		sourcePath: `patterns/${options.name}.md`
	});

const projection = (options: {
	readonly filePath?: string;
	readonly content: string;
}) =>
	new Input.Value({
		filePath: options.filePath === undefined
			? Option.none()
			: Option.some(options.filePath),
		content: Option.some(options.content),
		changedSpans: Option.none(),
		command: Option.none(),
		pattern: Option.none(),
		query: Option.none(),
		url: Option.none(),
		prompt: Option.none()
	});

describe('stripComments', () => {
	it('removes line comments but keeps strings intact', () => {
		const source =
			'const url = "http://not-a-comment"; // real comment\nconst n = 1;';
		const stripped = stripComments(source);
		expect(stripped).toContain('"http://not-a-comment"');
		expect(stripped).not.toContain('real comment');
	});
});

describe('regex detector', () => {
	it('matches after-event writes and reports a location', () => {
		const pattern = regexPattern({ name: 'no-process-env', pattern: 'process\\.env' });
		const matches = findPatternMatches(
			'write',
			projection({ filePath: 'src/env.ts', content: 'const k = process.env.KEY;\n' }),
			'after',
			pattern
		);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(1);
	});

	it('ignores matches inside comments when matchInComments is false', () => {
		const pattern = regexPattern({ name: 'no-ts-ignore', pattern: '@ts-ignore' });
		const source = '// never write @ts-ignore here\nexport const x = 1;\n';
		expect(
			findPatternMatches('write', projection({ filePath: 'src/a.ts', content: source }), 'after', pattern)
		).toHaveLength(0);
	});

	it('matches inside comments when matchInComments is true', () => {
		const pattern = regexPattern({
			name: 'ts-ignore-flagged',
			pattern: '@ts-ignore',
			matchInComments: true
		});
		const source = '// @ts-ignore\nexport const x = 1;\n';
		expect(
			findPatternMatches('write', projection({ filePath: 'src/a.ts', content: source }), 'after', pattern)
		).toHaveLength(1);
	});

	it('respects the event phase', () => {
		const pattern = regexPattern({ name: 'after-only', pattern: 'process\\.env' });
		expect(
			findPatternMatches('write', projection({ filePath: 'src/e.ts', content: 'process.env.X' }), 'before', pattern)
		).toHaveLength(0);
	});
});

describe('glob filtering', () => {
	it('skips files that do not match the pattern glob', () => {
		const pattern = regexPattern({
			name: 'ts-only',
			pattern: 'TODO',
			glob: '**/*.ts'
		});
		expect(
			findPatternMatches('write', projection({ filePath: 'src/readme.md', content: 'TODO' }), 'after', pattern)
		).toHaveLength(0);
		expect(
			findPatternMatches('write', projection({ filePath: 'src/code.ts', content: 'TODO' }), 'after', pattern)
		).toHaveLength(1);
	});
});

describe('ast detector (ast-grep)', () => {
	it.live('finds as-any assertions in TypeScript sources', () =>
		Effect.gen(function*() {
			const detector = new Pattern.AstDetector({
				patterns: ['$A as any']
			});
			const pattern = new Pattern.Value({
				name: 'avoid-any',
				description: 'test ast',
				event: 'after',
				toolRegex: '(write|edit)',
				level: 'warning',
				glob: '**/*.{ts,tsx}',
				detector,
				guidance: 'use Schema.decodeUnknown instead',
				sourcePath: 'patterns/avoid-any.md'
			});
			const matches = findPatternMatches(
				'write',
				projection({
					filePath: 'src/bad.ts',
					content: 'const value = input as any;\n'
				}),
				'after',
				pattern
			);
			yield* Effect.succeed(matches);
			expect(matches.length).toBe(1);
		}));

	it.live('does not flag clean code', () =>
		Effect.gen(function*() {
			const detector = new Pattern.AstDetector({ patterns: ['$A as any'] });
			const pattern = new Pattern.Value({
				name: 'avoid-any',
				description: 'test ast',
				event: 'after',
				toolRegex: '(write|edit)',
				level: 'warning',
				glob: '**/*.{ts,tsx}',
				detector,
				guidance: '',
				sourcePath: 'patterns/avoid-any.md'
			});
			const matches = findPatternMatches(
				'write',
				projection({
					filePath: 'src/good.ts',
					content: 'const value: unknown = input;\n'
				}),
				'after',
				pattern
			);
			yield* Effect.succeed(matches);
			expect(matches.length).toBe(0);
		}));
});
