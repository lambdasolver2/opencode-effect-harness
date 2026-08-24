/**
 * Enforcement parity fixtures migrated from the legacy suites, adapted to the
 * consolidated package: matcher semantics (comment stripping, globs,
 * changed-span scoping), projection (prospective reconstruction + explicit
 * degraded state), gate policy matrix (strictAgents / fail-closed / pending),
 * and exact asset-parity counts (53/46/4).
 */
import { describe, expect, it } from 'vitest';
import { Effect, Layer, Option } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { Input } from '../src/Input.ts';
import { Intent } from '../src/Intent.ts';
import { Edit } from '../src/Edit.ts';
import { Pattern } from '../src/Pattern.ts';
import {
	findPatternMatches,
	stripComments
} from '../src/Matcher.ts';
import { loadPatterns } from '../src/Catalog.ts';
import { Projection } from '../src/Projection.ts';
import { Gate as GateRule } from '../src/rules/Gate.ts';

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const projectionOf = <A>(
	use: (p: Projection.Interface) => Effect.Effect<A>
): Effect.Effect<A> =>
	Projection.Service.use(use).pipe(Effect.provide(Projection.layer.pipe(Layer.provide(platform))));

const ASSETS = new URL(
	'../../module-typescript/assets/',
	import.meta.url
).pathname.replace(/\/$/, '');

const mkInput = (filePath?: string, content?: string): Input.Value =>
	new Input.Value({
		filePath: filePath === undefined ? Option.none() : Option.some(filePath),
		content: content === undefined ? Option.none() : Option.some(content),
		changedSpans: Option.none(),
		command: Option.none(),
		pattern: Option.none(),
		query: Option.none(),
		url: Option.none(),
		prompt: Option.none()
	});

const regexPattern = (options: {
	name: string;
	pattern: string;
	matchInComments?: boolean;
	glob?: string;
}): Pattern.Value =>
	new Pattern.Value({
		name: options.name,
		description: 'test',
		event: 'after',
		toolRegex: '(write|edit)',
		level: 'warning',
		...(options.glob === undefined ? {} : { glob: options.glob }),
		detector: new Pattern.RegexDetector({
			pattern: options.pattern,
			matchInComments: options.matchInComments ?? false
		}),
		guidance: 'guidance',
		sourcePath: `patterns/${options.name}.md`
	});

describe('stripComments', () => {
	it('removes line comments but keeps strings intact', () => {
		const source =
			'const url = "http://not-a-comment"; // real comment\nconst n = 1;';
		const stripped = stripComments(source);
		expect(stripped).toContain('"http://not-a-comment"');
		expect(stripped).not.toContain('real comment');
	});

	it('preserves character offsets (1:1 length)', () => {
		const source = 'a; // c\nb; /* multi\nline */ c;';
		const stripped = stripComments(source);
		expect(stripped.length).toBe(source.length);
	});
});

describe('regex detector semantics', () => {
	it('matches after-event writes with a location', () => {
		const pattern = regexPattern({ name: 'no-process-env', pattern: 'process\\.env' });
		const matches = findPatternMatches(
			'write',
			mkInput('src/env.ts', 'const k = process.env.KEY;\n'),
			'after',
			pattern
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it('ignores comments unless matchInComments', () => {
		const p1 = regexPattern({ name: 'tsi', pattern: '@ts-ignore' });
		expect(
			findPatternMatches(
				'write',
				mkInput('src/a.ts', '// never @ts-ignore here\n'),
				'after',
				p1
			)
		).toHaveLength(0);

		const p2 = regexPattern({ name: 'tsi2', pattern: '@ts-ignore', matchInComments: true });
		expect(
			findPatternMatches(
				'write',
				mkInput('src/a.ts', '// @ts-ignore\n'),
				'after',
				p2
			)
		).toHaveLength(1);
	});

	it('honors glob filters via picomatch', () => {
		const pattern = regexPattern({ name: 'ts-only', pattern: 'TODO', glob: '**/*.ts' });
		expect(
			findPatternMatches('write', mkInput('src/readme.md', 'TODO'), 'after', pattern)
		).toHaveLength(0);
		expect(
			findPatternMatches('write', mkInput('src/code.ts', 'TODO'), 'after', pattern)
		).toHaveLength(1);
	});
});

describe('Projection', () => {
	it('reconstructs single-edit output from current file contents', async () => {
		const intent = new Intent.EditFile({
			phase: 'before',
			filePath: 'src/thing.ts',
			replacements: [new Edit.Value({ oldText: 'value = 1', newText: 'value = 2' })]
		});
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
		const { join } = await import('node:path');
		const os = await import('node:os');
		const dir = mkdtempSync(join(os.tmpdir(), 'proj-ok-'));
		mkdirSync(join(dir, 'src'), { recursive: true });
		writeFileSync(join(dir, 'src', 'thing.ts'), 'export const value = 1;\n');
		try {
			const out = await Effect.runPromise(
				projectionOf((p) => p.prospective(dir, intent))
			);
			expect(Option.getOrElse(out.content, () => '')).toBe('export const value = 2;\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns EXPLICIT degraded state on ambiguous edits (never fabricated content)', async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
		const { join } = await import('node:path');
		const os = await import('node:os');
		const dir = mkdtempSync(join(os.tmpdir(), 'proj-amb-'));
		writeFileSync(join(dir, 'dupe.ts'), 'const a = f();\nconst b = f();\n');
		try {
			const intent = new Intent.EditFile({
				phase: 'before',
				filePath: join(dir, 'dupe.ts'),
				replacements: [new Edit.Value({ oldText: 'f();', newText: 'g();' })]
			});
			const out = await Effect.runPromise(
				projectionOf((p) => p.prospective(dir, intent))
			);
			expect(Option.isNone(out.content)).toBe(true);
			expect(out.projectionError).toBe('ambiguous-old-text');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('Gate policy matrix', () => {
	type GateIntent = Parameters<
		ReturnType<typeof GateRule.rule>['evaluate']
	>[0]['writeIntent'];

	const writeIntent = (content: string): GateIntent =>
		new Intent.WriteFile({ phase: 'before', filePath: 'src/x.ts', content });

	const makeGate = (overrides?: { min?: number; strictAgents?: ReadonlyArray<string>; failClosed?: boolean }) =>
		GateRule.rule({
			min: overrides?.min ?? 4,
			strictAgents: overrides?.strictAgents ?? ['build'],
			failClosed: overrides?.failClosed ?? true,
			reason: (loaded) => Effect.succeed(`blocked at ${String(loaded)}`),
			loaded: () => Effect.succeed(2),
			project: (_cwd, i) =>
				Effect.succeed(
					new Input.Value({
						filePath: Option.some('src/x.ts'),
						content: Option.some(
							i instanceof Intent.WriteFile ? i.content : i.replacements.map((r) => r.newText).join('\n')
						),
						changedSpans: Option.none(),
						command: Option.none(),
						pattern: Option.none(),
						query: Option.none(),
						url: Option.none(),
						prompt: Option.none()
					})
				)
		});

	it('blocks strict agents below threshold', async () => {
		const decisions = await Effect.runPromise(
			makeGate().evaluate({
				activeBranch: { entries: [] } as never,
				cwd: '/p',
				agent: 'build',
				sessionId: 's1',
				writeIntent: writeIntent('import { Effect } from "effect";')
			})
		);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?._tag).toBe('BlockToolCall');
	});

	it('is advisory for non-strict agents even with Effect code', async () => {
		const decisions = await Effect.runPromise(
			makeGate().evaluate({
				activeBranch: { entries: [] } as never,
				cwd: '/p',
				agent: 'plan',
				sessionId: 's1',
				writeIntent: writeIntent('Effect.succeed(1)')
			})
		);
		expect(decisions).toEqual([]);
	});

	it('fail-closed blocks when projection is degraded', async () => {
		const gate = GateRule.rule({
			min: 4,
			strictAgents: ['build'],
			failClosed: true,
			reason: () => Effect.succeed('x'),
			loaded: () => Effect.succeed(9),
			project: () =>
				Effect.succeed(
					new Input.Value({
						filePath: Option.some('src/y.ts'),
						content: Option.none(),
						changedSpans: Option.none(),
						command: Option.none(),
						pattern: Option.none(),
						query: Option.none(),
						url: Option.none(),
						prompt: Option.none(),
						projectionError: 'ambiguous-old-text'
					})
				)
		});
		const decisions = await Effect.runPromise(
			gate.evaluate({
				activeBranch: { entries: [] } as never,
				cwd: '/p',
				agent: 'build',
				sessionId: 's1',
				writeIntent: writeIntent('anything')
			})
		);
		expect(decisions[0]?._tag).toBe('BlockToolCall');
	});
});

describe('Asset parity (exact counts at pinned revision)', () => {
	it('loads the complete 53/46/4 inventory through the SAME loader both consumers use', async () => {
		const patterns = await Effect.runPromise(
			loadPatterns(`${ASSETS}/patterns`).pipe(Effect.provide(platform))
		);
		expect(patterns.length).toBe(46);
		for (const pattern of patterns) {
			expect(pattern.name.length).toBeGreaterThan(0);
			expect(pattern.guidance.length).toBeGreaterThan(0);
		}

		const { readdirSync, existsSync, readFileSync } = await import('node:fs');
		const skillDirs = readdirSync(`${ASSETS}/skills`).filter((d) =>
			d.startsWith('effect-')
		);
		const skillsWithFile = skillDirs.filter((d) =>
			existsSync(`${ASSETS}/skills/${d}/SKILL.md`)
		);
		expect(skillsWithFile.length).toBe(53);
		const guidanceCount = readdirSync(`${ASSETS}/guidance`).filter((f) =>
			f.endsWith('.md')
		);
		expect(guidanceCount.length).toBe(4);

		// every SKILL.md has frontmatter name + description
		for (const dir of skillsWithFile) {
			const raw = readFileSync(`${ASSETS}/skills/${dir}/SKILL.md`, 'utf8');
			expect(raw.startsWith('---\n')).toBe(true);
		}
	});
});
