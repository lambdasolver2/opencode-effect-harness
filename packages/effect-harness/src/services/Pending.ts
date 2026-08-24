/**
 * Pending — in-flight skill reads keyed by tool-call id. A read is pending
 * between execute.before (read of a catalogued skill file) and execute.after
 * success. Counting pending reads alongside confirmed loads avoids the race
 * where the gate fires between call and result.
 */
import { Context, Effect, Layer, Option, Ref } from 'effect';

export namespace Pending {
	export interface Interface {
		readonly remember: (callId: string, skill: string) => Effect.Effect<void>;
		readonly take: (callId: string) => Effect.Effect<Option.Option<string>>;
		readonly names: Effect.Effect<ReadonlyArray<string>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/effect/Pending'
	) {}

	export const layer = Layer.effect(
		Service,
		Effect.gen(function*() {
			const ref = yield* Ref.make(new Map<string, string>());

			return Service.of({
				remember: (callId, skill) =>
					Ref.update(ref, (map) => new Map(map).set(callId, skill)),
				take: (callId) =>
					Effect.gen(function*() {
						const map = yield* Ref.get(ref);
						const skill = map.get(callId);
						yield* Ref.set(
							ref,
							new Map([...map].filter(([id]) => id !== callId))
						);
						return Option.fromUndefinedOr(skill);
					}),
				names: Effect.map(Ref.get(ref), (map) => [...new Set(map.values())])
			});
		})
	);
}
