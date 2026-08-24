/**
 * Ledger — per-session loaded-skill state.
 *
 * Sources of truth (spec A21/D5):
 *  - `session.skill.activated` events (primary)
 *  - successful read fallbacks via tool hooks
 *  - reset on an observed `session.compacted` event
 *  - a new plugin generation resets conservatively unless reconciled
 */
import { Context, Effect, Layer, Ref } from 'effect';

export namespace Ledger {
	export interface Interface {
		readonly mark: (session: string, skill: string) => Effect.Effect<void>;
		readonly loaded: (session: string) => Effect.Effect<ReadonlyArray<string>>;
		/** Distinct effect-* skills loaded + pending, for the gate. */
		readonly count: (
			session: string,
			pending: ReadonlyArray<string>
		) => Effect.Effect<number>;
		readonly reset: (session: string) => Effect.Effect<void>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/effect/Ledger'
	) {}

	export const layer = Layer.effect(
		Service,
		Effect.gen(function*() {
			const sessions = yield* Ref.make(new Map<string, ReadonlySet<string>>());

			const mark = (session: string, skill: string) =>
				Ref.update(sessions, (map) => {
					const current = map.get(session) ?? new Set<string>();
					return new Map(map).set(session, new Set(current).add(skill));
				});

			const loaded = (session: string) =>
				Effect.map(Ref.get(sessions), (map) => [...(map.get(session) ?? [])]);

			const count = (session: string, pending: ReadonlyArray<string>) =>
				Effect.map(loaded(session), (names) =>
					new Set(
						[...names, ...pending].filter((name) => name.startsWith('effect-'))
					).size
				);

			const reset = (session: string) =>
				Ref.update(sessions, (map) => {
					const next = new Map(map);
					next.delete(session);
					return next;
				});

			return Service.of({ mark, loaded, count, reset });
		})
	);
}
