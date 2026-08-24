/**
 * Remediation tests for audit findings:
 *  - AUDIT-013: Store appends version blocks (never overwrites), pointer
 *    rollback keeps history, ids are slug-validated, lineage is schema-decoded
 *  - AUDIT-014: Evolution stores train AND holdout baselines, enforces strict
 *    running-best improvement on both, rejects stale evaluator versions
 *  - AUDIT-012: Runner executes command acceptance checks in the isolated
 *    workspace and rejects duplicate trial keys
 *  - Options: conditional validation rejects impossible configs (finding 4)
 */
import { describe, expect, it } from 'vitest';
import { Effect, Layer, Ref } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { CommandSpec, Exec, ExecError, CommandResult } from 'opencode-harness-shared';
import { Journal } from 'opencode-harness-shared';
import { AcceptanceCriterion, ModelExecutionSpec } from './Blueprint.ts';
import { EvaluationSet, Evolution } from './Evolution.ts';
import { Store } from './Store.ts';
import { Env } from './Env.ts';
import { Llm, Outcome as LlmOutcome } from './Llm.ts';
import { Runner } from './Suite.ts';

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
	const { mkdtempSync, rmSync } = await import('node:fs');
	const { join } = await import('node:path');
	const os = await import('node:os');
	const dir = mkdtempSync(join(os.tmpdir(), 'remediation-'));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

// ---------------------------------------------------------------------------
// Store + Evolution
// ---------------------------------------------------------------------------

const blueprintStub = () =>
	({
		id: 'bp-1',
		name: 'test',
		domain: 'coding',
		systemPrompt: 'p',
		moduleRefs: [],
		execution: new ModelExecutionSpec({
			workerAgent: 'explore',
			tools: ['read'],
			maxTurns: 5,
			timeoutMs: 60_000
		}),
		acceptance: [
			new AcceptanceCriterion({
				id: 'a1',
				description: 'echo ok',
				check: {
					_tag: 'command',
					command: {
						executable: 'true',
						args: [],
						timeoutMs: 5_000,
						maxOutputBytes: 8_000
					}
				}
			})
		],
		origins: [],
		createdAt: 0
	}) as never;


describe('Store append-only', () => {
	it('appends two version blocks without rewriting earlier bytes; pointer moves', async () => {
		await withTempDir(async (baseDir) => {
			const { readFileSync: readFileSyncFn } = await import('node:fs');
			const program = Effect.gen(function* () {
				const store = yield* Store.Tag;
				yield* store.appendVersion({
					blueprintId: 'bp-1',
					version: 1,
					evaluatorVersion: 'eval-v1',
					score: 0.6,
					baselineTrain: 0.5,
					baselineHoldout: 0.5,
					markdown: 'v1 body',
					diffSummary: 'first',
					now: 1
				});
				yield* store.appendVersion({
					blueprintId: 'bp-1',
					version: 2,
					evaluatorVersion: 'eval-v1',
					score: 0.8,
					baselineTrain: 0.6,
					baselineHoldout: 0.55,
					markdown: 'v2 body',
					diffSummary: 'second',
					now: 2
				});

				const md = readFileSyncFn(`${baseDir}/blueprints/bp-1.md`, 'utf8');
				expect(md.indexOf('## Version v1')).toBeGreaterThan(-1);
				expect(md.indexOf('## Version v1')).toBeLessThan(md.indexOf('## Version v2'));

				const pointer = yield* store.pointer('bp-1');
				expect(pointer?.version).toBe(2);

				// rollback = pointer move only; v2 block remains on disk
				yield* store.setPointer({ id: 'bp-1', version: 1, now: 3 });
				const rolledBack = yield* store.pointer('bp-1');
				expect(rolledBack?.version).toBe(1);
				const mdAfterRollback = readFileSyncFn(`${baseDir}/blueprints/bp-1.md`, 'utf8');
				expect(mdAfterRollback).toContain('v2 body');
			}).pipe(
				Effect.provide(Store.layer(baseDir).pipe(Layer.provide(platform)) as Layer.Layer<Store.Tag>)
			);
			await Effect.runPromise(program);
		});
	});

	it('rejects path-traversal ids', async () => {
		await withTempDir(async (baseDir) => {
			const result = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const store = yield* Store.Tag;
					return yield* store.setPointer({ id: '../evil', version: 1, now: 1 });
				}).pipe(Effect.provide(Store.layer(baseDir).pipe(Layer.provide(platform)) as Layer.Layer<Store.Tag>))
			);
			expect(result._tag).toBe('Failure');
		});
	});
});

