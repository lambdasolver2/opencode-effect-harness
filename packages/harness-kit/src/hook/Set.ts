import { Context, Effect, Layer } from 'effect';

import type * as Hook from './Hook.ts';

export namespace HookSet {
	export interface Interface {
		readonly all: Effect.Effect<ReadonlyArray<Hook.Any>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/HookSet'
	) {}

	export const make = (hooks: ReadonlyArray<Hook.Any>): Interface => ({
		all: Effect.succeed(hooks)
	});

	export const empty: Layer.Layer<Service> = Layer.succeed(Service, Service.of(make([])));

	export const of = (hooks: ReadonlyArray<Hook.Any>): Layer.Layer<Service> =>
		Layer.succeed(Service, Service.of(make(hooks)));
}
