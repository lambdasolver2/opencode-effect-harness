/**
 * ModeState — Ref-backed harness mode with per-project storage persistence.
 * Disabling stops header/gate/feedback but telemetry keeps running (parity
 * invariant). Storage failures surface as a typed error instead of being
 * silently ignored (audit finding: swallowed mode persistence).
 */
import { Context, Effect, Layer, Ref, Schema } from 'effect';

export class ModePersistenceError extends Schema.TaggedError<ModePersistenceError>()(
	'ModePersistenceError',
	{ projectKey: Schema.String, reason: Schema.String }
) {}

export interface HostStorage {
	get(key: string): Effect.Effect<unknown>;
	set(key: string, value: unknown): Effect.Effect<void>;
}

export namespace ModeState {
	export interface Interface {
		enabled(projectKey: string): Effect.Effect<boolean>;
		set(input: {
			readonly projectKey: string;
			readonly enabled: boolean;
		}): Effect.Effect<boolean, ModePersistenceError>;
	}

	export class Tag extends Context.Service<Tag, Interface>()(
		'opencode-effect-harness/opencode/ModeState'
	) {}

	const keyFor = (projectKey: string): string =>
		`opencode-effect-harness/mode/${projectKey}`;

	interface StoredMode {
		readonly enabled?: unknown;
	}

	export const make = (storage: HostStorage): Interface => {
		const cache: Ref.Ref<Map<string, boolean>> = Effect.runSync(
			Ref.make(new Map<string, boolean>())
		);

		const loadOnce = (projectKey: string): Effect.Effect<boolean> =>
			Effect.gen(function*() {
				const cached = yield* Ref.get(cache).pipe(Effect.map((m) => m.get(projectKey)));
				if (cached !== undefined) return cached;
				const raw = yield* storage.get(keyFor(projectKey)).pipe(
					Effect.orElseSucceed(() => undefined)
				);
				const stored = raw as StoredMode | undefined;
				const enabled = typeof stored?.enabled === 'boolean' ? stored.enabled : true;
				yield* Ref.update(cache, (m) => new Map(m).set(projectKey, enabled));
				return enabled;
			});

		return {
			enabled: loadOnce,
			set: ({ projectKey, enabled }) =>
				Effect.gen(function*() {
					yield* storage
						.set(keyFor(projectKey), { enabled, updatedAt: new Date().toISOString() })
						.pipe(
							Effect.mapError(() =>
								new ModePersistenceError({ projectKey, reason: 'storage write failed' })
							)
						);
					yield* Ref.update(cache, (m) => new Map(m).set(projectKey, enabled));
					return enabled;
				})
		};
	};

	export const layerFrom = (storage: HostStorage): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(make(storage)));
}
