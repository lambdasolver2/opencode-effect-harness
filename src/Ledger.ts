/**
 * SkillLedger + PendingReads — session-SCOPED loaded-skill state.
 *
 * Fixes AUDIT-025: pending reads are keyed by (project, session, call) — a
 * read in one session can never unlock another session's gate — and failed
 * reads are released on the terminal after-event instead of leaking. Loaded
 * skills persist to storage per project/session so reloads restore observed
 * state; compaction clears both memory and persisted journal.
 */
import { Context, Effect, Layer, Ref } from 'effect';

export interface HostStorage {
	get(key: string): Effect.Effect<unknown>;
	set(key: string, value: unknown): Effect.Effect<void>;
	remove?(key: string): Effect.Effect<void>;
}

const storageRemove = (storage: HostStorage, key: string): Effect.Effect<void> =>
	storage.remove !== undefined
		? storage.remove(key)
		: storage.set(key, { skills: [] });

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

	const composite = (projectKey: string, sessionID: string): string =>
		`${projectKey} ${sessionID}`;

	export const make = (storage: HostStorage): Interface => {
		const sessions: Ref.Ref<Map<string, ReadonlySet<string>>> = Effect.runSync(
			Ref.make(new Map<string, ReadonlySet<string>>())
		);

		const hydrate = (
			projectKey: string,
			sessionID: string
		): Effect.Effect<ReadonlySet<string>> =>
			Effect.gen(function*() {
				const key = composite(projectKey, sessionID);
				const known = yield* Ref.get(sessions).pipe(Effect.map((m) => m.get(key)));
				if (known !== undefined) return known;
				const raw = yield* storage.get(storageKey(projectKey, sessionID)).pipe(
					Effect.orElseSucceed(() => undefined)
				);
				const list = Array.isArray((raw as StoredJournal | undefined)?.skills)
					? ((raw as StoredJournal).skills as ReadonlyArray<unknown>)
					: [];
				const restored: ReadonlySet<string> = new Set(
					list.filter((n): n is string => typeof n === 'string' && isEffectSkill(n))
				);
				yield* Ref.update(sessions, (m) => new Map(m).set(key, restored));
				return restored;
			});

		const persist = (
			projectKey: string,
			sessionID: string,
			skills: ReadonlySet<string>
		): Effect.Effect<void> =>
			storage
				.set(storageKey(projectKey, sessionID), { skills: [...skills] })
				.pipe(Effect.ignore, Effect.asVoid);

		return {
			mark: ({ projectKey, sessionID, skill }) =>
				Effect.flatMap(hydrate(projectKey, sessionID), (current) => {
					if (!isEffectSkill(skill)) return Effect.void;
					const next: ReadonlySet<string> = new Set(current).add(skill);
					return Effect.asVoid(
						Effect.all([
							Ref.update(sessions, (m) => new Map(m).set(composite(projectKey, sessionID), next)),
							persist(projectKey, sessionID, next)
						])
					);
				}),
			countDistinct: ({ projectKey, sessionID, pending }) =>
				Effect.map(hydrate(projectKey, sessionID), (loaded) => {
					const relevant = [...loaded, ...pending].filter(isEffectSkill);
					return new Set(relevant).size;
				}),
			reset: ({ projectKey, sessionID }) =>
				Effect.asVoid(
					Effect.all([
						Ref.update(sessions, (m) => {
							const next = new Map(m);
							next.delete(composite(projectKey, sessionID));
							return next;
						}),
						storageRemove(storage, storageKey(projectKey, sessionID)).pipe(Effect.ignore)
					])
				),
			loadedNames: ({ projectKey, sessionID }) =>
				Effect.map(hydrate(projectKey, sessionID), (set) => [...set])
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

	interface Entry {
		readonly projectKey: string;
		readonly sessionID: string;
		readonly skill: string;
	}

	const scopedKey = (input: {
		projectKey: string;
		sessionID: string;
		callId: string;
	}): string => `${input.projectKey} ${input.sessionID} ${input.callId}`;

	export const make = (): Interface => {
		const entries: Ref.Ref<Map<string, Entry>> = Effect.runSync(Ref.make(new Map<string, Entry>()));

		return {
			remember: (input) =>
				Ref.update(entries, (map) => new Map(map).set(scopedKey(input), input)),
			take: (input) =>
				Effect.gen(function*() {
					const key = scopedKey(input);
					const map = yield* Ref.get(entries);
					const found = map.get(key)?.skill;
					yield* Ref.set(entries, new Map([...map].filter(([k]) => k !== key)));
					return found;
				}),
			names: (input) =>
				Effect.map(Ref.get(entries), (map) => {
					const prefix = `${input.projectKey} ${input.sessionID} `;
					return [
						...new Set(
							[...map.entries()]
								.filter(([k]) => k.startsWith(prefix))
								.map(([, v]) => v.skill)
								.filter((skill) => skill.startsWith('effect-'))
						)
					];
				})
		};
	};

	export const layer: Layer.Layer<Tag> = Layer.succeed(Tag, Tag.of(make()));
}
