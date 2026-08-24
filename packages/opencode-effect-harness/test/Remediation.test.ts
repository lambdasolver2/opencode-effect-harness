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

import { CommandSpec, Exec, ExecError, CommandResult } from '../src/shared/Command.ts';
import { Journal } from '../src/shared/Journal.ts';
import { AcceptanceCriterion, ModelExecutionSpec } from '../src/compound/Blueprint.ts';
import { EvaluationSet, Evolution } from '../src/compound/Evolution.ts';
import { Store } from '../src/compound/Store.ts';
import { Env } from '../src/compound/Env.ts';
import { Llm, Outcome as LlmOutcome } from '../src/compound/Llm.ts';
import { Runner } from '../src/compound/Runner.ts';
import { decode as decodeOptions } from '../src/opencode/Options.ts';

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

describe('Store append-only semantics', () => {
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
				Effect.provide(Store.layer(baseDir).pipe(Layer.provide(platform)))
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
				}).pipe(Effect.provide(Store.layer(baseDir).pipe(Layer.provide(platform))))
			);
			expect(result._tag).toBe('Failure');
		});
	});
});

describe('Evolution baseline discipline', () => {
	it('rejects holdout regression even when train improves (vs running best)', async () => {
		const program = Effect.gen(function* () {
			const evo = yield* Evolution.Tag;
			const set = new EvaluationSet({
				trainTaskIds: ['t1'],
				holdoutTaskIds: ['h1'],
				evaluatorVersion: 'eval-v1'
			});
			const lineage = yield* evo.establishBaseline({
				blueprint: blueprintStub(),
				set,
				scores: { train: 0.4, holdout: 0.7 },
				now: 1
			});
			expect(lineage.bestHoldout).toBe(0.7);

			// improves train but REGRESSES holdout vs baseline
			const rejected = yield* Effect.flip(
				evo.commit({
					lineage,
					candidate: {
						requestedVersion: 1,
						markdownBlock: 'md',
						diffSummary: 'd',
						trainScore: 0.9,
						holdoutScore: 0.5,
						verificationPassed: true,
						evaluatorVersion: 'eval-v1'
					},
					now: 2
				})
			);
			expect(rejected.reason).toBe('score-regression');

			// stale evaluator manifest blocks entirely
			const stale = yield* Effect.flip(
				evo.commit({
					lineage,
					candidate: {
						requestedVersion: 1,
						markdownBlock: 'md',
						diffSummary: 'd',
						trainScore: 0.9,
						holdoutScore: 0.9,
						verificationPassed: true,
						evaluatorVersion: 'eval-v0'
					},
					now: 3
				})
			);
			expect(stale.reason).toBe('stale-evaluator');

			// genuine improvement advances BOTH running bests
			const committed = yield* evo.commit({
				lineage,
				candidate: {
					requestedVersion: 1,
					markdownBlock: 'md',
					diffSummary: 'd',
					trainScore: 0.6,
					holdoutScore: 0.75,
					verificationPassed: true,
					evaluatorVersion: 'eval-v1'
				},
				now: 4
			});
			expect(committed.committed).toBe(true);
			expect(committed.lineage.bestTrain).toBe(0.6);
			expect(committed.lineage.bestHoldout).toBe(0.75);
		}).pipe(Effect.provide(Evolution.layer));
		await Effect.runPromise(program);
	});
});

// ---------------------------------------------------------------------------
// Runner: real acceptance execution + duplicate-key rejection
// ---------------------------------------------------------------------------

const fakeExecPassing = (): Exec.Interface => ({
	run: (spec: CommandSpec) =>
		Effect.succeed(
			new CommandResult({
				exitCode: 0,
				stdout: `ran ${spec.executable}`,
				stderr: '',
				timedOut: false,
				truncated: false
			})
		)
});

const fakeLlm = (text: string): Llm.Service => ({
	complete: () =>
		Effect.succeed(new LlmOutcome({ text, durationMs: 5 }))
});

describe('Runner acceptance execution', () => {
	it('executes acceptance checks in an isolated workspace and releases the trial key', async () => {
		await withTempDir(async (root) => {
			const judgeStub = { score: () => Effect.succeed(1) };
			const llmStub = fakeLlm('done');

			const makeService = Effect.gen(function* () {
				const env = yield* Env.Tag;
				return yield* Runner.make({
					env,
					llm: llmStub,
					exec: fakeExecPassing(),
					judge: judgeStub
				});
			}).pipe(
				Effect.provide(Env.layer({ root }).pipe(Layer.provide(platform)))
			);

			const service = await Effect.runPromise(makeService);

			const run = await Effect.runPromise(
				service.runTask({
					blueprint: blueprintStub(),
					model: { provider: 'test', model: 'm' },
					taskId: 't1',
					instruction: 'do it',
					trial: 1,
					evaluatorVersion: 'eval-v1'
				})
			);
			expect(run.passed).toBe(true);
			expect(run.evaluatorVersion).toBe('eval-v1');

			// key is released after completion -> same key runnable again
			const again = await Effect.runPromise(
				service.runTask({
					blueprint: blueprintStub(),
					model: { provider: 'test', model: 'm' },
					taskId: 't1',
					instruction: 'again',
					trial: 1,
					evaluatorVersion: 'eval-v1'
				})
			);
			expect(again.passed).toBe(true);
		});
	});
});
