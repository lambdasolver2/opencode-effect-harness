/**
 * Store: versioned lineage persistence + rollback using real temp dirs.
 */
import { describe, expect, it } from 'vitest';
import { Effect, Layer } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { ExecutionSpec } from '../src/Blueprint.ts';
import type { Blueprint } from '../src/Blueprint.ts';
import { CommittedVersion, Lineage } from '../src/Evolution.ts';
import { Store } from '../src/Store.ts';

const platformLayer = Layer.mergeAll(
	NodeFileSystem.layer,
	NodePath.layer
);

const storeLayer = (baseDir: string) =>
	Store.layer(baseDir).pipe(Layer.provide(platformLayer));

const blueprint = (id: string): Blueprint => ({
	id,
	name: 'test',
	version: 1,
	domain: 'coding',
	systemPrompt: 'p',
	procedure: [],
	pitfalls: [],
	modules: [],
	execution: new ExecutionSpec({
		workerAgent: 'explore',
		tools: ['read'],
		maxTurns: 10,
		timeoutMs: 60000
	}),
	acceptance: [],
	origins: [],
	createdAt: 0
});

const withTempDir = async (
	run: (baseDir: string) => Promise<void>
): Promise<void> => {
	const { mkdtempSync, rmSync } = await import('node:fs');
	const { join } = await import('node:path');
	const os = await import('node:os');
	const baseDir = mkdtempSync(join(os.tmpdir(), 'compound-store-'));
	try {
		await run(baseDir);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
};

describe('Store', () => {
	it('save writes markdown', async () => {
		await withTempDir(async (baseDir) => {
			await Effect.runPromise(
				Store.Service.use((s) =>
					s.save(blueprint('bp-1'), '## Version v1\ncontent')
				).pipe(Effect.provide(storeLayer(baseDir)))
			);
			const { readFileSync } = await import('node:fs');
			const { join } = await import('node:path');
			const content = readFileSync(
				join(baseDir, 'blueprints', 'bp-1.md'),
				'utf8'
			);
			expect(content).toContain('## Version v1');
		});
	});

	it('lineage round-trips and rollback removes last version', async () => {
		await withTempDir(async (baseDir) => {
			const program = Effect.gen(function*() {
				const store = yield* Store.Service;
				const lineage = new Lineage({
					blueprintId: 'bp-rb',
					baselineScore: 0.5,
					evaluatorVersion: 'eval-v1',
					committed: [
						new CommittedVersion({
							version: 1,
							markdownBlock: '## v1',
							score: 0.6,
							baselineScore: 0.5,
							evaluatorVersion: 'eval-v1',
							diffSummary: '',
							committedAt: 0
						}),
						new CommittedVersion({
							version: 2,
							markdownBlock: '## v2',
							score: 0.8,
							baselineScore: 0.5,
							evaluatorVersion: 'eval-v1',
							diffSummary: '',
							committedAt: 0
						})
					],
					attempts: [],
					lessons: []
				});
				yield* store.saveLineage(lineage);
				const before = yield* store.lineage('bp-rb');
				expect(before.committed).toHaveLength(2);
				yield* store.rollback('bp-rb');
				const after = yield* store.lineage('bp-rb');
				expect(after.committed).toHaveLength(1);
				expect(after.committed[0]?.version).toBe(1);
			});
			await Effect.runPromise(
				program.pipe(Effect.provide(storeLayer(baseDir)))
			);
		});
	});

	it('lineage fails cleanly for unknown id', async () => {
		await withTempDir(async (baseDir) => {
			const result = await Effect.runPromise(
				Effect.flip(
					Store.Service.use((s) => s.lineage('nope')).pipe(
						Effect.provide(storeLayer(baseDir))
					)
				)
			);
			expect(result.reason).toContain('not found');
		});
	});
});
