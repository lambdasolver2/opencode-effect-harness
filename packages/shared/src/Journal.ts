/**
 * Journal — the ONE reusable append-only event-store abstraction.
 *
 * Used by critic findings/dispositions, compound proposals/approvals,
 * evolution attempts, plan checkpoints, and live trace capture. Each concrete
 * producer owns its own event schema and validates payloads before calling
 * `append`; the journal validates and seals the envelope.
 *
 * Guarantees:
 *  - append is the only mutation; no update/delete operation exists
 *  - per-stream serialization via a semaphore; concurrent writers never interleave
 *  - every entry carries a monotonic sequence and a hash chained to its predecessor
 *  - request IDs make retried appends idempotent (the original entry is returned)
 *  - a corrupted tail fails loudly on read; `repair` quarantines it explicitly
 *    into `<stream>.corrupt-*` and never silently rewrites history
 *
 * The hash is an FNV-based ordering fingerprint (tamper-evident sequencing),
 * not a cryptographic signature; it detects accidental truncation/reordering.
 */
import {
	Clock,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Ref,
	Schema
} from 'effect';
import { Semaphore } from 'effect';

import { fnv1aHex } from './Hash.ts';

export class JournalEntry extends Schema.Class<JournalEntry>('JournalEntry')({
	sequence: Schema.Number,
	recordedAt: Schema.Number,
	actor: Schema.String,
	kind: Schema.String,
	payload: Schema.Unknown,
	previousHash: Schema.String,
	hash: Schema.String
}) {}

export class JournalError extends Schema.TaggedError<JournalError>()(
	'JournalError',
	{
		operation: Schema.Literals(['append', 'read', 'repair']),
		stream: Schema.String,
		reason: Schema.String
	}
) {}

const GENESIS_HASH = 'genesis';

export namespace Journal {
	export interface AppendInput {
		readonly stream: string;
		readonly kind: string;
		readonly payload: unknown;
		readonly actor?: string | undefined;
		readonly requestId?: string | undefined;
		/** Injected clock — deterministic in tests via TestClock. */
		readonly now?: number | undefined;
	}

	export interface Interface {
		readonly append: (input: AppendInput) => Effect.Effect<JournalEntry, JournalError>;
		readonly read: (stream: string) => Effect.Effect<ReadonlyArray<JournalEntry>, JournalError>;
		readonly latest: (stream: string) => Effect.Effect<Option.Option<JournalEntry>, JournalError>;
		readonly repair: (stream: string) => Effect.Effect<number, JournalError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/shared/Journal'
	) {}
}

const safeSegment = (value: string): boolean =>
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);

const stableStringify = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
};

const seal = (
	sequence: number,
	previousHash: string,
	kind: string,
	payload: unknown,
	recordedAt: number,
	actor: string
): string =>
	fnv1aHex(
		`${sequence}|${previousHash}|${kind}|${fnv1aHex(stableStringify(payload))}|${recordedAt}|${actor}`
	);

const toIdIndex = (value: unknown): IdIndex => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([key, seq]) =>
			typeof seq === 'number' && Number.isInteger(seq) && seq >= 0
				? [[key, seq] as const]
				: []
		)
	);
};

interface IdIndex {
	readonly [requestId: string]: number;
}

interface ParsedLine {
	readonly ok: true;
	readonly entry: JournalEntry;
}

interface BadLine {
	readonly ok: false;
}

type ParsedLineResult = ParsedLine | BadLine;

const parseLine = (line: string): ParsedLineResult => {
	try {
		const entry = Schema.decodeUnknownSync(JournalEntry)(JSON.parse(line));
		return { ok: true, entry };
	} catch {
		return { ok: false };
	}
};

export namespace Journal {
	interface Deps {
		readonly fs: FileSystem.FileSystem;
		readonly path: Path.Path;
	}

	export const layer = (baseDir: string) =>
		Layer.effect(
			Journal.Service,
			Effect.gen(function*() {
				const deps: Deps = {
					fs: yield* FileSystem.FileSystem,
					path: yield* Path.Path
				};
				yield* Effect.ignore(deps.fs.makeDirectory(baseDir, { recursive: true }));

				const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
				const lockFor = (stream: string) =>
					Ref.modify(locks, (map) => {
						const existing = map.get(stream);
						if (existing !== undefined) return [existing, map] as const;
						const created = Semaphore.makeUnsafe(1);
						return [created, new Map(map).set(stream, created)] as const;
					});

				const filePathOf = (stream: string) =>
					deps.path.join(baseDir, `${stream}.ndjson`);
				const idsPathOf = (stream: string) =>
					deps.path.join(baseDir, `${stream}.ids.json`);

				const guarded = <A>(
					stream: string,
					effect: Effect.Effect<A, JournalError>
				): Effect.Effect<A, JournalError> =>
					Effect.flatMap(lockFor(stream), (semaphore) =>
						semaphore.withPermits(1)(effect)
					);

				const toError = (
					stream: string,
					operation: JournalError['operation'],
					reason: string
				) => new JournalError({ operation, stream, reason });

				// Missing file == empty history; an EXISTING but unreadable file
				// fails loudly instead of being silently treated as empty.
				const readFileRaw = (stream: string): Effect.Effect<string, JournalError> =>
					deps.fs.exists(filePathOf(stream)).pipe(
						Effect.catchTag('PlatformError', () => Effect.succeed(false)),
						Effect.flatMap((exists) =>
							exists
								? deps.fs.readFileString(filePathOf(stream)).pipe(
										Effect.catchTag(
											'PlatformError',
											() =>
												Effect.fail(
													toError(stream, 'read', 'stream file unreadable')
												)
										)
								  )
								: Effect.succeed('')
						)
					);

				const decodeEntries = (
					raw: string,
					stream: string
				): Effect.Effect<ReadonlyArray<JournalEntry>, JournalError> =>
					Effect.suspend(() => {
						if (raw.trim().length === 0) return Effect.succeed([]);
						const lines = raw.split('\n').filter((line) => line.length > 0);
						return Effect.forEach(
							lines,
							(line) => Effect.succeed(parseLine(line)),
							{ concurrency: 1 }
						).pipe(
							Effect.flatMap((parsed) => {
								const firstBad = parsed.findIndex((p) => !p.ok);
								if (firstBad !== -1) {
									return Effect.fail(
										toError(
											stream,
											'read',
											`corrupt entry after ${String(firstBad)} valid entries`
										)
									);
								}
								return Effect.succeed(
									parsed.flatMap((p) => (p.ok ? [p.entry] : []))
										).pipe(
									// Tamper-evidence: sequence, linkage, seal verified on read.
									Effect.flatMap((entries) => {
										const brokenAt = entries.findIndex((entry, index) => {
											if (entry.sequence !== index) return true;
											const expected = seal(
												entry.sequence,
												entry.previousHash,
												entry.kind,
												entry.payload,
												entry.recordedAt,
												entry.actor
											);
											if (entry.hash !== expected) return true;
											const previous =
												index === 0 ? GENESIS_HASH : entries[index - 1]?.hash;
											return entry.previousHash !== previous;
										});
										return brokenAt === -1
											? Effect.succeed(entries)
											: Effect.fail(
													toError(
														stream,
														'read',
														`broken chain at entry ${String(brokenAt)}`
													)
												);
									})
								);
							})
						);
					});

				const readIds = (stream: string): Effect.Effect<IdIndex> =>
					deps.fs.readFileString(idsPathOf(stream)).pipe(
						Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw) as unknown)),
						Effect.map(toIdIndex),
						Effect.orElseSucceed(() => ({}) as IdIndex)
					);

				const writeAtomic = (target: string, data: string) =>
					Effect.gen(function*() {
						const tmp =
							target +
							`.tmp-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
						yield* deps.fs.writeFileString(tmp, data);
						yield* deps.fs.rename(tmp, target);
					}).pipe(
						Effect.catchTag('PlatformError', () =>
							Effect.fail(toError('internal', 'append', `atomic write failed: ${target}`))
						)
					);

				const append: Interface['append'] = (input) =>
					guarded(input.stream, Effect.gen(function*() {
						if (!safeSegment(input.stream)) {
							return yield* Effect.fail(
								toError(input.stream, 'append', 'invalid stream name')
							);
						}
						if (input.kind.trim().length === 0) {
							return yield* Effect.fail(
								toError(input.stream, 'append', 'empty kind')
							);
						}

						const raw = yield* readFileRaw(input.stream);
						const entries = yield* decodeEntries(raw, input.stream);
						const ids = yield* readIds(input.stream);
						const requestId = input.requestId;

						if (requestId !== undefined && requestId in ids) {
							const replay = entries.find(
								(entry) => entry.sequence === ids[requestId]
							);
							if (replay !== undefined) return replay;
						}

						const last = entries.at(-1);
						const sequence = entries.length;
						const recordedAt = input.now ?? (yield* Clock.currentTimeMillis);
						const actor = input.actor ?? 'system';
						const previousHash = last?.hash ?? GENESIS_HASH;
						const entry = new JournalEntry({
							sequence,
							recordedAt,
							actor,
							kind: input.kind,
							payload: input.payload,
							previousHash,
							hash: seal(sequence, previousHash, input.kind, input.payload, recordedAt, actor)
						});

						const nextRaw =
							raw.length === 0
								? `${JSON.stringify(entry)}\n`
								: `${raw.replace(/\n$/, '')}\n${JSON.stringify(entry)}\n`;
						yield* writeAtomic(filePathOf(input.stream), nextRaw);

						if (input.requestId !== undefined) {
							yield* writeAtomic(idsPathOf(input.stream), JSON.stringify({
								...ids,
								[input.requestId]: sequence
							}));
						}
						return entry;
					}));

				const read: Interface['read'] = (stream) =>
					safeSegment(stream)
						? Effect.flatMap(readFileRaw(stream), (raw) =>
								decodeEntries(raw, stream)
						  )
						: Effect.fail(toError(stream, 'read', 'invalid stream name'));

				const latest: Interface['latest'] = (stream) =>
					Effect.map(read(stream), (entries) => Option.fromUndefinedOr(entries.at(-1)));

				const repair: Interface['repair'] = (stream) =>
					guarded(stream, Effect.gen(function*() {
						if (!safeSegment(stream)) {
							return yield* Effect.fail(toError(stream, 'repair', 'invalid stream name'));
						}
						const raw = yield* readFileRaw(stream);
						if (raw.trim().length === 0) return 0;
						const lines = raw.split('\n').filter((line) => line.length > 0);
						const parsed = lines.map(parseLine);
						const validCount = parsed.findIndex((p) => !p.ok) === -1
							? parsed.length
							: parsed.findIndex((p) => !p.ok);
						const quarantined = lines.length - validCount;
						return yield* (quarantined > 0
							? Effect.gen(function*() {
								const quarantineTarget = deps.path.join(
									baseDir,
									`${stream}.corrupt-${Date.now()}`
								);
								// Quarantine MUST succeed before history is rewritten;
								// otherwise the corrupt bytes remain the only copy.
								yield* deps.fs.writeFileString(
										quarantineTarget,
										lines.slice(validCount).join('\n') + '\n'
									).pipe(
										Effect.catchTag('PlatformError', () =>
											Effect.fail(
												toError(stream, 'repair', 'quarantine write failed')
											)
										)
									);
								const kept =
									validCount === 0
										? ''
										: lines.slice(0, validCount).join('\n') + '\n';
								yield* writeAtomic(filePathOf(stream), kept);
								return quarantined;
							  })
							: Effect.succeed(0));
					}));

				return Journal.Service.of({ append, read, latest, repair });
			})
		);
}
