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
			const rejected: { reason: string } = yield* Effect.flip(
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
			const stale: { reason: string } = yield* Effect.flip(
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
			const committed: { lineage: typeof lineage; committed: boolean } = yield* evo.commit({
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

