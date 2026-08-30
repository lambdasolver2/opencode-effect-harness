import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { Effect, Layer, Option } from 'effect';
import * as NodeFs from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { loadPatterns } from 'opencode-harness-kit/Catalog.ts';
import { Input } from 'opencode-harness-kit/Input.ts';
import { findPatternMatches } from 'opencode-harness-kit/Matcher.ts';

import { baseline } from './Baseline.ts';

const platform = Layer.mergeAll(NodeFs.layer, NodePath.layer);

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'coverage',
	'.workspaces'
]);
const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

const isScanned = (rel: string): boolean =>
	(rel.endsWith('.ts') || rel.endsWith('.tsx')) &&
	!rel.endsWith('.test.ts') &&
	!rel.startsWith('src/vitest.');

const walk = async (dir: string, base: string): Promise<Array<string>> => {
	const out: Array<string> = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const rel = entry.isDirectory() ? undefined : `${base}${entry.name}`;
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) {
				out.push(...(await walk(`${dir}/${entry.name}`, `${base}${entry.name}/`)));
			}
		} else if (rel !== undefined && isScanned(rel)) {
			out.push(rel);
		}
	}
	return out;
};

describe('self-pattern scan (whole repo vs baseline)', () => {
	it(
		'introduces no NEW detector hits and keeps the baseline honest',
		async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const patterns = yield* loadPatterns(
						'packages/module-typescript/assets/patterns'
					);
					const rels = (yield* Effect.promise(() =>
						walk(REPO_ROOT, '')
					)).sort();
					const hits: Record<string, Array<string>> = {};
					yield* Effect.forEach(
						rels,
						(rel) =>
							Effect.gen(function* () {
								const content = yield* Effect.promise(() =>
									readFile(`${REPO_ROOT}/${rel}`, 'utf8')
								);
								const projection = new Input.Value({
									filePath: Option.some(rel),
									content: Option.some(content),
									changedSpans: Option.none(),
									command: Option.none(),
									pattern: Option.none(),
									query: Option.none(),
									url: Option.none(),
									prompt: Option.none()
								});
								const found = [
									...new Set(
										patterns
											.filter(
												(p) =>
													findPatternMatches('write', projection, 'after', p)
														.length > 0
											)
											.map((p) => p.name)
									)
								].sort();
								if (found.length > 0) hits[rel] = found;
							}),
						{ concurrency: 4, discard: true }
					);
					return { patterns: patterns.length, hits };
				}).pipe(Effect.provide(platform))
			);

			expect(result.patterns).toBeGreaterThan(0);
			const newViolations: Array<string> = [];
			for (const [file, found] of Object.entries(result.hits)) {
				const allowed = baseline[file] ?? [];
				for (const name of found) {
					if (!allowed.includes(name)) newViolations.push(`${file}: ${name}`);
				}
			}
			const stale: Array<string> = [];
			for (const [file, allowed] of Object.entries(baseline)) {
				const found = result.hits[file] ?? [];
				for (const name of allowed) {
					if (!found.includes(name)) stale.push(`${file}: ${name}`);
				}
			}

			expect(newViolations).toEqual([]);
			expect(stale).toEqual([]);
		},
		180_000
	);
});
