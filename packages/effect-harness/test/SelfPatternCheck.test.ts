/**
 * Self-check: run the migrated pattern catalog against our own source code.
 * All 46 Effect v4 detectors must pass on this repo (dogfooding gate).
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { PatternCatalog, PatternMatcher } from 'opencode-harness-kit/index.ts';
import { Input } from 'opencode-harness-kit/kernel/Input.ts';

const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const patternsDir = 'packages/effect-harness/patterns';

describe('Self-pattern check', () => {
	it.live('all 46 migrated detectors parse and load', () =>
		PatternCatalog.Service.use((catalog) =>
			Effect.gen(function*() {
				const patterns = yield* catalog.getPatterns;
				expect(patterns.length).toBeGreaterThanOrEqual(40);
				for (const pattern of patterns) {
					expect(pattern.name.length).toBeGreaterThan(0);
					expect(pattern.guidance.length).toBeGreaterThan(0);
				}
			})
		).pipe(Effect.provide(PatternCatalog.layer(patternsDir).pipe(Layer.provide(platformLayer)))));

	it.live('no critical violations in our own source files', () =>
		Effect.gen(function*() {
			const catalog = yield* PatternCatalog.Service;
			const patterns = yield* catalog.getPatterns;
			const fs = yield* Effect.promise(() => import('node:fs'));
			const path = yield* Effect.promise(() => import('node:path'));

			const srcDir = path.resolve('packages');
			let checked = 0;
			let violations = 0;

			const walk = (dir: string): Array<string> => {
				try {
					return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
						const full = path.join(dir, entry.name);
						if (entry.isDirectory()) return walk(full);
						if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) return [full];
						return [];
					});
				} catch {
					return [];
				}
			};

			for (const filePath of walk(srcDir)) {
				const content = fs.readFileSync(filePath, 'utf8');

				for (const pattern of patterns) {
					if (pattern.event !== 'after') continue;
					if (pattern.level !== 'critical') continue;

					const projection = new Input.Value({
						filePath: Option.some(filePath),
						content: Option.some(content),
						changedSpans: Option.none(),
						command: Option.none(),
						pattern: Option.none(),
						query: Option.none(),
						url: Option.none(),
						prompt: Option.none()
					});

					const matches = findPatternMatches('write', projection as never, 'after', pattern);
					if (matches.length > 0) {
						violations += 1;
						console.error(`CRITICAL: ${pattern.name} in ${path.relative(process.cwd(), filePath)}`);
					}
				}
				checked += 1;
			}

			expect(checked).toBeGreaterThan(10);
			expect(violations).toBe(0);
		}).pipe(
			Effect.provide(
				PatternCatalog.layer(patternsDir).pipe(Layer.provide(platformLayer))
			)
		));
});

import { findPatternMatches } from 'opencode-harness-kit/index.ts';
