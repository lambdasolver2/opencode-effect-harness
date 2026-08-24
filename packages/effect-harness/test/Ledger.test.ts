/**
 * Ledger + Pending: loaded-skill bookkeeping and in-flight read credits.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';

import { Ledger } from '../src/services/Ledger.ts';
import { Pending } from '../src/services/Pending.ts';

const layers = Layer.mergeAll(Ledger.layer, Pending.layer);

describe('Ledger', () => {
	it.live('marks skills and counts distinct effect-* skills plus pending', () =>
		Effect.gen(function*() {
			const ledger = yield* Ledger.Service;
			yield* ledger.mark('ses_1', 'effect-error-handling');
			yield* ledger.mark('ses_1', 'effect-error-handling'); // duplicate
			yield* ledger.mark('ses_1', 'effect-layer-design');
			const count = yield* ledger.count('ses_1', ['effect-schema-v4']);
			expect(count).toBe(3);
		}).pipe(Effect.provide(layers)));

	it.live('ignores non-effect-* pending names in the count', () =>
		Effect.gen(function*() {
			const ledger = yield* Ledger.Service;
			yield* ledger.mark('ses_2', 'effect-stream');
			const count = yield* ledger.count('ses_2', ['unrelated-skill']);
			expect(count).toBe(1);
		}).pipe(Effect.provide(layers)));

	it.live('reset clears the session (compaction boundary)', () =>
		Effect.gen(function*() {
			const ledger = yield* Ledger.Service;
			yield* ledger.mark('ses_3', 'effect-fiber');
			yield* ledger.reset('ses_3');
			const loaded = yield* ledger.loaded('ses_3');
			expect(loaded).toEqual([]);
		}).pipe(Effect.provide(layers)));
});

describe('Pending', () => {
	it.live('remember/take round-trips once, then empties', () =>
		Effect.gen(function*() {
			const pending = yield* Pending.Service;
			yield* pending.remember('call-1', 'effect-schema-v4');
			const taken = yield* pending.take('call-1');
			expect(Option.isSome(taken)).toBe(true);
			if (Option.isSome(taken)) expect(taken.value).toBe('effect-schema-v4');

			const again = yield* pending.take('call-1');
			expect(Option.isNone(again)).toBe(true);
		}).pipe(Effect.provide(layers)));

	it.live('names exposes distinct pending skill names for the gate race fix', () =>
		Effect.gen(function*() {
			const pending = yield* Pending.Service;
			yield* pending.remember('a', 'effect-cli');
			yield* pending.remember('b', 'effect-cli'); // same skill, different call
			yield* pending.remember('c', 'effect-config');
			const names = yield* pending.names;
			expect([...names].sort()).toEqual(['effect-cli', 'effect-config']);
		}).pipe(Effect.provide(layers)));
});
