import { Context, Effect, Layer } from 'effect';

import type * as Rule from './Rule.ts';

export namespace RuleSet {
	export interface Interface {
		readonly all: Effect.Effect<ReadonlyArray<Rule.Any>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/RuleSet'
	) {}

	export const make = (rules: ReadonlyArray<Rule.Any>): Interface => ({
		all: Effect.succeed(rules)
	});

	export const empty: Layer.Layer<Service> = Layer.succeed(Service, Service.of(make([])));

	export const of = (rules: ReadonlyArray<Rule.Any>): Layer.Layer<Service> =>
		Layer.succeed(Service, Service.of(make(rules)));
}
