import { Context, Effect, Layer } from 'effect';

import type * as Hook from '../../harness/Hook.ts';

export namespace HookSet {
	export interface Interface {
		readonly all: Effect.Effect<ReadonlyArray<Hook.Any>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/kernel/HookSet'
	) {}

	export const empty = Layer.succeed(
		Service,
		Service.of({ all: Effect.succeed([]) })
	);

	export const of = (hooks: ReadonlyArray<Hook.Any>) =>
		Layer.succeed(Service, Service.of({ all: Effect.succeed(hooks) }));

	export const fromEffect = <E, R>(
		build: Effect.Effect<ReadonlyArray<Hook.Any>, E, R>
	) => Layer.effect(
		Service,
		Effect.map(build, (hooks) => Service.of({ all: Effect.succeed(hooks) }))
	);
}
