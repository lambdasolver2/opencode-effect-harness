import { Context, Effect, Layer } from 'effect';

import type * as Rule from '../../harness/Rule.ts';

export namespace RuleSet {
	export interface Interface {
		readonly all: Effect.Effect<ReadonlyArray<Rule.Any>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/kernel/RuleSet'
	) {}

	export const empty = Layer.succeed(
		Service,
		Service.of({ all: Effect.succeed([]) })
	);

	export const of = (rules: ReadonlyArray<Rule.Any>) =>
		Layer.succeed(Service, Service.of({ all: Effect.succeed(rules) }));

	/**
	 * Mode gating lives inside `RuleSet.all`, exactly like upstream: hooks stay
	 * installed even when the mode is disabled (so skill reads are still
	 * credited), while rules evaluate to empty when disabled.
	 */
	export const fromEffect = <E, R>(
		build: Effect.Effect<ReadonlyArray<Rule.Any>, E, R>
	) => Layer.effect(
		Service,
		Effect.map(build, (rules) => Service.of({ all: Effect.succeed(rules) }))
	);
}
