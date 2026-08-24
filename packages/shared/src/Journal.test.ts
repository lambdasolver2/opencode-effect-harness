/**
 * Append-only journal contract tests (audit AUDIT-013/023 remediation):
 * monotonic sequence + hash chain, request-id idempotency, corrupt tail
 * fails loudly on read and is quarantined by explicit repair only.
 */
import { describe, expect, it } from 'vitest';
import { Effect, Layer } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { Journal } from '../src/Journal.ts';

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
	const { mkdtempSync, rmSync } = await import('node:fs');
	const { join } = await import('node:path');
	const os = await import('node:os');
	const dir = mkdtempSync(join(os.tmpdir(), 'oej-'));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe('Journal (append-only)', () => {
	it('appends with monotonic sequence and chained hashes; replays by requestId', async () => {
		await withTempDir(async (baseDir) => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const j = yield* Journal.Service;
					const a = yield* j.append({
						stream: 'critic-test',
						kind: 'review.started',
						payload: { n: 1 },
						actor: 'test',
						now: 1
					});
					expect(a.sequence).toBe(0);
					expect(a.previousHash).toBe('genesis');

					const b = yield* j.append({
						stream: 'critic-test',
						kind: 'finding.raised',
						payload: { n: 2 },
						actor: 'test',
						requestId: 'req-1',
						now: 2
					});
					expect(b.sequence).toBe(1);
					expect(b.previousHash).toBe(a.hash);

					const replay = yield* j.append({
						stream: 'critic-test',
						kind: 'finding.raised',
						payload: { DIFFERENT: true },
						actor: 'test',
						requestId: 'req-1',
						now: 99
					});
					expect(replay.sequence).toBe(b.sequence);
					expect(replay.hash).toBe(b.hash);

					const all = yield* j.read('critic-test');
					expect(all).toHaveLength(2);
				}).pipe(Effect.provide(Journal.layer(baseDir).pipe(Layer.provide(platform))))
			);
		});
	});

	it('fails loudly on a corrupt tail and repairs only via explicit repair', async () => {
		await withTempDir(async (baseDir) => {
			const { appendFileSync, readdirSync } = await import('node:fs');
			await Effect.runPromise(
				Effect.gen(function* () {
					const j = yield* Journal.Service;
					yield* j.append({ stream: 's', kind: 'a', payload: { i: 0 }, now: 1 });
					yield* j.append({ stream: 's', kind: 'b', payload: { i: 1 }, now: 2 });

					appendFileSync(`${baseDir}/s.ndjson`, '{"sequence":2,"torn');

						const failed = yield* Effect.flip(j.read('s'));
					expect(failed.reason).toContain('corrupt entry');

					const quarantined = yield* j.repair('s');
					expect(quarantined).toBeGreaterThan(0);
					const after = yield* j.read('s');
					expect(after).toHaveLength(2);

					const files = readdirSync(baseDir).filter((f: string) => f.includes('.corrupt'));
					expect(files.length).toBe(1);
				}).pipe(Effect.provide(Journal.layer(baseDir).pipe(Layer.provide(platform))))
			);
		});
	});

	it('rejects invalid stream names instead of writing traversal paths', async () => {
		await withTempDir(async (baseDir) => {
			const result = await Effect.runPromiseExit(
				journalAppendSafe(baseDir, '../escape')
			);
			if (result._tag === 'Failure') {
				const causeJson = JSON.stringify(result.cause);
				expect(causeJson).toContain('invalid stream name');
			} else {
				throw new Error('expected failure');
			}
		});
	});
});

const journalAppendSafe = (baseDir: string, stream: string) =>
	Effect.gen(function* () {
		const j = yield* Journal.Service;
		return yield* j.append({ stream, kind: 'x', payload: {} });
	}).pipe(Effect.provide(Journal.layer(baseDir).pipe(Layer.provide(platform))));
