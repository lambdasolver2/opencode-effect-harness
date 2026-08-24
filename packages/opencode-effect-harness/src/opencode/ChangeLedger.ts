/**
 * ChangeLedger — per-(project, session) record of successful write/edit paths
 * fed by the after-hook. Execution-boundary triggers consume and coalesce this
 * ledger (execution events carry no diff), clearing entries only after a run
 * is recorded (spec A26). Also serves as the bounded ChangeSet source.
 */
import { Context, Effect, Layer, Ref } from 'effect';

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
	size(input: { readonly projectKey: string }): Effect.Effect<number>;
}

export namespace ChangeLedger {
	export class Tag extends Context.Service<Tag, ChangeLedgerInterface>()(
		'opencode-effect-harness/opencode/ChangeLedger'
	) {}

	const composite = (projectKey: string, sessionID: string): string =>
		`${projectKey} ${sessionID}`;

	export const make = (): ChangeLedgerInterface => {
		const state: Ref.Ref<Map<string, ReadonlySet<string>>> = Effect.runSync(
			Ref.make(new Map<string, ReadonlySet<string>>())
		);

		return {
			record: ({ projectKey, sessionID, filePath }) =>
				Ref.update(state, (map) => {
					const key = composite(projectKey, sessionID);
					const current = map.get(key) ?? new Set<string>();
					return new Map(map).set(key, new Set(current).add(filePath));
				}),
			drain: ({ projectKey, sessionID }) =>
				Effect.gen(function*() {
					const key = composite(projectKey, sessionID);
					const current = yield* Ref.get(state).pipe(Effect.map((m) => m.get(key)));
					yield* Ref.update(state, (map) => {
						const next = new Map(map);
						next.delete(key);
						return next;
					});
					return [...(current ?? [])].sort();
				}),
			size: ({ projectKey }) =>
				Effect.map(Ref.get(state), (map) =>
					[...map.entries()]
						.filter(([k]) => k.startsWith(`${projectKey} `))
						.reduce((sum, [, files]) => sum + files.size, 0)
				)
		};
	};

	export const layer: Layer.Layer<Tag> =
		Layer.succeed(Tag, Tag.of(make()));
}
