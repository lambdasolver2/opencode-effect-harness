/**
 * PatternCatalog tests run against the REAL migrated pattern assets in
 * harnesses/effect/patterns — enforcing 1:1 asset parity with upstream and
 * that every detector parses.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Path as EffectPath } from 'effect';

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { Pattern } from '../src/Pattern.ts';
import {
	loadPatterns,
	Catalog,
	toRuleDefinition
} from '../src/kernel/services/Catalog.ts';

const platformLayer = Layer.mergeAll(
	NodeFileSystem.layer,
	NodePath.layer
);

const patternsDir = (path: EffectPath.Path): string =>
	typeof import.meta.dirname === 'string'
		? path.resolve(import.meta.dirname, '../../effect-harness/patterns')
		: patternsDirFromRoot(path);

// Fallback for runtimes without import.meta.dirname (vitest fork pool):
// resolve from the workspace root.
const patternsDirFromRoot = (path: EffectPath.Path): string =>
	path.resolve('packages/effect-harness/patterns');

const catalogLayer = Layer.unwrap(
	Effect.gen(function*() {
		const path = yield* EffectPath.Path;
		return Catalog.layer(patternsDir(path));
	})
).pipe(Layer.provide(platformLayer));

describe('PatternCatalog (real migrated assets)', () => {
	it.live('loads the full migrated pattern inventory (>= 40 patterns)', () =>
		Catalog.Service.use((catalog) =>
			Effect.gen(function*() {
				const patterns = yield* catalog.getPatterns;
				expect(patterns.length).toBeGreaterThanOrEqual(40);
				for (const pattern of patterns) {
					expect(pattern.name.length).toBeGreaterThan(0);
					expect(pattern.guidance.length).toBeGreaterThan(0);
					expect(pattern.sourcePath.endsWith('.md')).toBe(true);
				}
			})
		).pipe(Effect.provide(catalogLayer)));

	it.live('contains the canonical avoid-any pattern as a warning-level AST rule', () =>
		Catalog.Service.use((catalog) =>
			Effect.gen(function*() {
				const patterns = yield* catalog.getPatterns;
				const avoidAny = patterns.find((pattern) => pattern.name === 'avoid-any');
				expect(avoidAny).toBeDefined();
				expect(avoidAny?.level).toBe('warning');
				expect(avoidAny?.detector).toBeInstanceOf(Pattern.AstDetector);
			})
		).pipe(Effect.provide(catalogLayer)));

	it.live('maps every pattern to a legacy injectUserMessage rule definition', () =>
		Catalog.Service.use((catalog) =>
			Effect.gen(function*() {
				const rules = yield* catalog.getRules;
				const patterns = yield* catalog.getPatterns;
				expect(rules.length).toBe(patterns.length);
				for (const rule of rules) {
					expect(rule.action).toBe('injectUserMessage');
					expect(rule.id.startsWith('legacy-pattern:')).toBe(true);
				}
			})
		).pipe(Effect.provide(catalogLayer)));

	it.live('loadPatterns is deterministic across calls', () =>
		Effect.gen(function*() {
			const path = yield* EffectPath.Path;
			const dir = patternsDir(path);
			const first = yield* loadPatterns(dir);
			const second = yield* loadPatterns(dir);
			expect(first.length).toBe(second.length);
			expect(first.map((pattern) => pattern.sourcePath)).toEqual(
				second.map((pattern) => pattern.sourcePath)
			);
		}).pipe(Effect.provide(platformLayer)));

	it('toRuleDefinition preserves severity and name', () => {
		const pattern = new Pattern.Value({
			name: 'my-pattern',
			description: 'desc',
			event: 'after',
			toolRegex: '.*',
			level: 'critical',
			detector: new Pattern.RegexDetector({
				pattern: 'x',
				matchInComments: false
			}),
			guidance: 'g',
			sourcePath: 'p.md'
		});
		const rule = toRuleDefinition(pattern);
		expect(rule.severity).toBe('critical');
		expect(rule.patternName).toBe('my-pattern');
	});
});
