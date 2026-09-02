/**
 * Ledger — the ONE abstract domain for scope-keyed set state.
 *
 * Every ledger in the composition root is a set of strings owned by a
 * (project, session[, call]) scope:
 *  - Ledger (SkillLedger): loaded effect-* skills, persisted per scope.
 *  - PendingReads: in-flight skill reads keyed by tool-call id.
 *  - ChangeLedger: touched file paths fed by the after-hook.
 *
 * The abstract core is ScopedSets: pure scope-key algebra plus a single
 * Ref-backed string-set store. The three domains are thin specializations
 * that keep their exact public Interface, Context.Tag, and (for skills)
 * storage-key format.
 */
import { Context, Effect, Layer, Ref } from 'effect';
import { sort } from 'effect/Array';
import { String as StringOrder } from 'effect/Order';

export interface HostStorage {
	get(key: string): Effect.Effect<unknown>;
	set(key: string, value: unknown): Effect.Effect<void>;
	remove?(key: string): Effect.Effect<void>;
}

const storageRemove = (storage: HostStorage, key: string): Effect.Effect<void> =>
	storage.remove !== undefined
		? storage.remove(key)
		: storage.set(key, { skills: [] });

export interface Scope {
	readonly projectKey: string;
	readonly sessionID: string;
	readonly callId?: string;
}

export namespace ScopedSets {
	export const keyOf = (scope: Scope): string =>
		scope.callId === undefined
			? `${scope.projectKey} ${scope.sessionID}`
			: `${scope.projectKey} ${scope.sessionID} ${scope.callId}`;

	export const prefixOf = (projectKey: string, sessionID?: string): string =>
		sessionID === undefined ? `${projectKey} ` : `${projectKey} ${sessionID} `;

	type Sets = Map<string, ReadonlySet<string>>;

	export const added = (map: Sets, key: string, value: string): Sets => {
		const current = map.get(key) ?? new Set<string>();
		return new Map(map).set(key, new Set(current).add(value));
	};

	export const seeded = (map: Sets, key: string, values: ReadonlyArray<string>): Sets => {
		const current = map.get(key) ?? new Set<string>();
		return new Map(map).set(key, new Set([...current, ...values]));
	};

	export const removed = (map: Sets, key: string): Sets => {
		const next = new Map(map);
		next.delete(key);
		return next;
	};

	export const sortedValuesAt = (map: Sets, key: string): Array<string> =>
		sort(Array.from(map.get(key) ?? []), StringOrder);

	export const scanValues = (map: Sets, prefix: string): Array<string> => [
		...new Set(
			[...map.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.flatMap(([, values]) => [...values])
		)
	];

	export const countWithPrefix = (map: Sets, prefix: string): number =>
		[...map.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.reduce((sum, [, values]) => sum + values.size, 0);

	export interface Store {
		add(scope: Scope, value: string): Effect.Effect<void>;
		seed(scope: Scope, values: ReadonlyArray<string>): Effect.Effect<void>;
		values(scope: Scope): Effect.Effect<ReadonlyArray<string>>;
		take(scope: Scope): Effect.Effect<ReadonlyArray<string>>;
		reset(scope: Scope): Effect.Effect<void>;
		scan(projectKey: string, sessionID?: string): Effect.Effect<ReadonlyArray<string>>;
		count(projectKey: string): Effect.Effect<number>;
	}

	export const makeStore = (): Store => {
		const state: Ref.Ref<Sets> = Effect.runSync(Ref.make(new Map<string, ReadonlySet<string>>()));

		return {
			add: (scope, value) => Ref.update(state, (map) => added(map, keyOf(scope), value)),
			seed: (scope, values) => Ref.update(state, (map) => seeded(map, keyOf(scope), values)),
			values: (scope) =>
				Effect.map(Ref.get(state), (map) => sortedValuesAt(map, keyOf(scope))),
			take: (scope) =>
				Effect.gen(function*() {
					const current = yield* Ref.get(state).pipe(
						Effect.map((map) => sortedValuesAt(map, keyOf(scope)))
					);
					yield* Ref.update(state, (map) => removed(map, keyOf(scope)));
					return current;
				}),
			reset: (scope) => Ref.update(state, (map) => removed(map, keyOf(scope))),
			scan: (projectKey, sessionID) =>
				Effect.map(Ref.get(state), (map) => scanValues(map, prefixOf(projectKey, sessionID))),
			count: (projectKey) =>
				Effect.map(Ref.get(state), (map) => countWithPrefix(map, prefixOf(projectKey)))
		};
	};
}

export namespace Ledger {
	export interface Interface {
		mark(input: {
			readonly projectKey: string;
			readonly sessionID: string;
			readonly skill: string;
		}): Effect.Effect<void>;
		countDistinct(input: {
			readonly projectKey: string;
			readonly sessionID: string;
			readonly pending: ReadonlyArray<string>;
		}): Effect.Effect<number>;
		reset(input: {
			readonly projectKey: string;
			readonly sessionID: string;
		}): Effect.Effect<void>;
		loadedNames(input: {
			readonly projectKey: string;
			readonly sessionID: string;
		}): Effect.Effect<ReadonlyArray<string>>;
	}

	export class Tag extends Context.Service<Tag, Interface>()(
		'opencode-effect-harness/opencode/SkillLedger'
	) {}

	const storageKey = (projectKey: string, sessionID: string): string =>
		`opencode-effect-harness/skills/${projectKey}/${sessionID}`;

	interface StoredJournal {
		readonly skills?: unknown;
	}

	const isEffectSkill = (name: string): boolean => name.startsWith('effect-');

	export const make = (storage: HostStorage): Interface => {
		const memory = ScopedSets.makeStore();
		const hydrated: Ref.Ref<ReadonlySet<string>> = Effect.runSync(
			Ref.make<ReadonlySet<string>>(new Set<string>())
		);

		const hydrateOnce = (scope: Scope): Effect.Effect<void> =>
			Effect.gen(function*() {
				const key = ScopedSets.keyOf(scope);
				const done = yield* Ref.get(hydrated).pipe(Effect.map((keys) => keys.has(key)));
				if (done) return;
				const raw = yield* storage.get(storageKey(scope.projectKey, scope.sessionID)).pipe(
					Effect.orElseSucceed(() => undefined)
				);
				const list = Array.isArray((raw as StoredJournal | undefined)?.skills)
					? ((raw as StoredJournal).skills as ReadonlyArray<unknown>)
					: [];
				yield* memory.seed(
					scope,
					list.filter((n): n is string => typeof n === 'string' && isEffectSkill(n))
				);
				yield* Ref.update(hydrated, (keys) => new Set(keys).add(key));
			});

		const persist = (
			projectKey: string,
			sessionID: string,
			skills: ReadonlyArray<string>
		): Effect.Effect<void> =>
			storage
				.set(storageKey(projectKey, sessionID), { skills: [...skills] })
				.pipe(Effect.ignore, Effect.asVoid);

		return {
			mark: ({ projectKey, sessionID, skill }) =>
				Effect.gen(function*() {
					const scope: Scope = { projectKey, sessionID };
					yield* hydrateOnce(scope);
					if (!isEffectSkill(skill)) return;
					yield* memory.add(scope, skill);
					yield* persist(projectKey, sessionID, yield* memory.values(scope));
				}),
			countDistinct: ({ projectKey, sessionID, pending }) =>
				Effect.gen(function*() {
					const scope: Scope = { projectKey, sessionID };
					yield* hydrateOnce(scope);
					const relevant = [...(yield* memory.values(scope)), ...pending].filter(isEffectSkill);
					return new Set(relevant).size;
				}),
			reset: ({ projectKey, sessionID }) => {
				const scope: Scope = { projectKey, sessionID };
				return Effect.asVoid(
					Effect.all([
						memory.reset(scope),
						Ref.update(hydrated, (keys) => {
							const next = new Set(keys);
							next.delete(ScopedSets.keyOf(scope));
							return next;
						}),
						storageRemove(storage, storageKey(projectKey, sessionID)).pipe(Effect.ignore)
					])
				);
			},
			loadedNames: ({ projectKey, sessionID }) =>
				Effect.gen(function*() {
					const scope: Scope = { projectKey, sessionID };
					yield* hydrateOnce(scope);
					return yield* memory.values(scope);
				})
		};
	};

	export const layerFrom = (storage: HostStorage): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(make(storage)));
}

export namespace PendingReads {
	export interface Interface {
		remember(input: {
			readonly projectKey: string;
			readonly sessionID: string;
			readonly callId: string;
			readonly skill: string;
		}): Effect.Effect<void>;
		/** Terminal cleanup: returns and removes the entry for THIS call only. */
		take(input: {
			readonly projectKey: string;
			readonly sessionID: string;
			readonly callId: string;
		}): Effect.Effect<string | undefined>;
		names(input: {
			readonly projectKey: string;
			readonly sessionID: string;
		}): Effect.Effect<ReadonlyArray<string>>;
	}

	export class Tag extends Context.Service<Tag, Interface>()(
		'opencode-effect-harness/opencode/PendingReads'
	) {}

	const isEffectSkill = (name: string): boolean => name.startsWith('effect-');

	export const make = (): Interface => {
		const memory = ScopedSets.makeStore();

		return {
			remember: (input) => memory.add(input, input.skill),
			take: (input) => Effect.map(memory.take(input), (values) => values[0]),
			names: (input) =>
				Effect.map(memory.scan(input.projectKey, input.sessionID), (skills) =>
					skills.filter(isEffectSkill)
				)
		};
	};

	export const layer: Layer.Layer<Tag> = Layer.succeed(Tag, Tag.of(make()));
}

export interface ChangeLedgerInterface {
	record(input: {
		readonly projectKey: string;
		readonly sessionID: string;
		readonly filePath: string;
	}): Effect.Effect<void>;
	drain(input: {
		readonly projectKey: string;
		readonly sessionID: string;
	}): Effect.Effect<ReadonlyArray<string>>;
	/** Read WITHOUT clearing so failed verification retains the change set. */
	peek(input: {
		readonly projectKey: string;
		readonly sessionID: string;
	}): Effect.Effect<ReadonlyArray<string>>;
	size(input: { readonly projectKey: string }): Effect.Effect<number>;
}

export namespace ChangeLedger {
	export class Tag extends Context.Service<Tag, ChangeLedgerInterface>()(
		'opencode-effect-harness/opencode/ChangeLedger'
	) {}

	export const make = (): ChangeLedgerInterface => {
		const memory = ScopedSets.makeStore();

		return {
			record: (input) => memory.add(input, input.filePath),
			drain: (input) => memory.take(input),
			peek: (input) => memory.values(input),
			size: (input) => memory.count(input.projectKey)
		};
	};

	export const layer: Layer.Layer<Tag> =
		Layer.succeed(Tag, Tag.of(make()));
}
