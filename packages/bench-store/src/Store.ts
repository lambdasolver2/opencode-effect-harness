/**
 * SqliteStore — the canonical SQLite adapter for the benchmark `TaskStore`
 * port (spec 06 §3). Effect SQL only (`@effect/sql-sqlite-node`); no direct
 * driver imports, no raw JSON parsing (string payloads are Schema codecs).
 *
 * Guarantees (types/schema over runtime `if`s):
 *  - DbFilename is a UNION: Memory needs no platform; File REQUIRES the
 *    platform layer — the parent directory is created strictly BEFORE the
 *    driver opens the file (no mkdir/open race possible);
 *  - task revisions immutable; identical-revision upsert is idempotent;
 *  - trials: pending rows batch-inserted at job creation; completeTrial is a
 *    guarded `UPDATE ... WHERE status='pending' RETURNING` — double
 *    completion is Option.none, never an overwrite; the optional score is
 *    written in the SAME transaction;
 *  - completeJob is ONE transaction: guarded job status + INSERT-only leading
 *    + hash-chained history event;
 *  - history chain is VERIFIED on read (typed error, never silent);
 *  - unknown-variant/model and File-without-platform are construction-time
 *    typed errors.
 */
import { Clock, Effect, FileSystem, Layer, Match, Option, Path, Schema } from 'effect';

import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-node';
import { SqlClient, SqlError } from 'effect/unstable/sql';
import { Reactivity } from 'effect/unstable/reactivity';

import { fnv1aHex } from 'opencode-harness-shared/Hash.ts';
import { ModelProfile, Task, TaskError, TaskSpec } from 'opencode-compound-kit/Task.ts';
import {
	TaskStore,
	type CreateJobInput,
	type HistoryInput,
	type ScoreInput,
	type UpsertTaskInput
} from 'opencode-compound-kit/task/Store.ts';

type CompleteJobInput = TaskStore.CompleteJobInput;
type TrialOutcome = TaskStore.TrialOutcome;

// ---------------------------------------------------------------------------
// Database filename: a UNION type, not string-mode ifs
// ---------------------------------------------------------------------------

export type DbFilename =
	| { readonly _tag: 'Memory' }
	| { readonly _tag: 'File'; readonly path: string };

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const MIGRATIONS: Readonly<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>> = {
	'0001_benchmark_store': Effect.gen(function*() {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE IF NOT EXISTS model_profiles (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			variant TEXT,
			created_at_ms INTEGER NOT NULL
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			domain TEXT NOT NULL,
			current_revision TEXT NOT NULL,
			updated_at_ms INTEGER NOT NULL
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS task_revisions (
			revision TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES tasks(id),
			spec_json TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS benchmark_jobs (
			job_id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			task_revision TEXT NOT NULL,
			blueprint_id TEXT,
			blueprint_hash TEXT,
			evaluator_id TEXT NOT NULL,
			rubric_hash TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled'))
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS benchmark_trials (
			trial_id TEXT PRIMARY KEY,
			job_id TEXT NOT NULL REFERENCES benchmark_jobs(job_id),
			blueprint_id TEXT NOT NULL,
			blueprint_hash TEXT NOT NULL,
			task_id TEXT NOT NULL,
			task_revision TEXT NOT NULL,
			profile_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			variant TEXT,
			trial INTEGER NOT NULL,
			status TEXT NOT NULL CHECK (status IN
				('pending','running','scored','contract-invalid','llm-error','timeout','interrupted','judge-unavailable')),
			output_text TEXT,
			output_bytes INTEGER,
			output_hash TEXT,
			duration_ms INTEGER,
			tokens_in INTEGER,
			tokens_out INTEGER,
			session_id TEXT,
			error_reason TEXT,
			started_at_ms INTEGER,
			finished_at_ms INTEGER,
			UNIQUE (job_id, blueprint_id, blueprint_hash, task_revision, profile_id, variant, trial)
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS trial_scores (
			score_id TEXT PRIMARY KEY,
			trial_id TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
			evaluator_id TEXT NOT NULL,
			rubric_hash TEXT NOT NULL,
			deterministic_json TEXT NOT NULL,
			dimensions_json TEXT NOT NULL,
			total REAL NOT NULL CHECK (total >= 0 AND total <= 1),
			scored_at_ms INTEGER NOT NULL
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS leading_solutions (
			job_id TEXT PRIMARY KEY REFERENCES benchmark_jobs(job_id),
			trial_id TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
			total REAL NOT NULL,
			selected_at_ms INTEGER NOT NULL
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS benchmark_history (
			event_id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			previous_hash TEXT NOT NULL,
			hash TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			UNIQUE (job_id, sequence)
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS benchmark_trace_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trial_id TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
			sequence INTEGER NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			UNIQUE (trial_id, sequence)
		)`;
		yield* sql`CREATE TABLE IF NOT EXISTS benchmark_trace_events_v2 (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trial_id TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
			sequence INTEGER NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			previous_hash TEXT NOT NULL,
			hash TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			UNIQUE (trial_id, sequence)
		)`;
	}),
	'0002_benchmark_trace_events_v2': Effect.gen(function*() {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`CREATE TABLE IF NOT EXISTS benchmark_trace_events_v2 (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			trial_id TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
			sequence INTEGER NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			previous_hash TEXT NOT NULL,
			hash TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			UNIQUE (trial_id, sequence)
		)`;
	})
};

const MigratorLayer = SqliteMigrator.layer({
	loader: SqliteMigrator.fromRecord(MIGRATIONS)
});

type PlatformLayer = Layer.Layer<FileSystem.FileSystem | Path.Path, never, never>;

const buildGraph = (filename: DbFilename): Layer.Layer<SqlClient.SqlClient, SqlError.SqlError> =>
	Match.value(filename).pipe(
		Match.when({ _tag: 'Memory' }, () => SqliteClient.layer({ filename: ':memory:' })),
		Match.when({ _tag: 'File' }, ({ path }) => SqliteClient.layer({ filename: path })),
		Match.exhaustive
	);

/** Layer overloads — the TYPES force a platform layer for file databases:
 *  `layer({ _tag: 'Memory' })` and `layer({ _tag: 'File', path }, platform)`.
 *  A File database without a platform layer is a COMPILE error. */
export function layer(filename: { readonly _tag: 'Memory' }): Layer.Layer<
	TaskStore.Tag,
	TaskError | import('effect/unstable/sql/SqlError').SqlError | import('effect/unstable/sql/Migrator').MigrationError,
	never
>;
export function layer(
	filename: { readonly _tag: 'File'; readonly path: string },
	platform: PlatformLayer
): Layer.Layer<
	TaskStore.Tag,
	TaskError | import('effect/unstable/sql/SqlError').SqlError | import('effect/unstable/sql/Migrator').MigrationError,
	never
>;
export function layer(
	filename: DbFilename,
	platform?: PlatformLayer
): Layer.Layer<
	TaskStore.Tag,
	TaskError | import('effect/unstable/sql/SqlError').SqlError | import('effect/unstable/sql/Migrator').MigrationError,
	never
> {
	// Strict order: mkdir (File only) runs BEFORE the driver opens the file —
	// guaranteed by building the client layer INSIDE the unwrap continuation.
	const mkdir = Match.value(filename).pipe(
		Match.when({ _tag: 'Memory' }, () => Effect.void as Effect.Effect<void, TaskError, PlatformLayer>),
		Match.when({ _tag: 'File' }, ({ path }) =>
			Effect.gen(function*() {
				const fs = yield* FileSystem.FileSystem;
				const pathService = yield* Path.Path;
				const parent = pathService.dirname(pathService.resolve(path));
				yield* fs
					.makeDirectory(parent, { recursive: true })
					.pipe(Effect.catchTag('PlatformError', (cause) => Effect.die(cause)));
			}).pipe(
				Effect.catchDefect((cause) => Effect.die(cause)),
				Effect.asVoid
			)
		),
		Match.exhaustive
	);
	const mkdirEffect =
		platform === undefined
			? Effect.map(mkdir, () => undefined).pipe(
					Effect.catchTag('TaskError', (error) =>
						Effect.succeed({
							_kind: 'missing-platform' as const,
							reason: error.reason
						})
					)
				)
			: Effect.map(Effect.provide(mkdir, platform), () => undefined);
	const withMigrations = Layer.unwrap(
		Effect.flatMap(mkdirEffect, (dirResult) => {
			if (dirResult !== undefined && dirResult._kind === 'missing-platform') {
				return Effect.fail(
					new TaskError({
						operation: 'layer',
						reason: `File database requires the platform layer: ${dirResult.reason}`
					})
				);
			}
			const client = Layer.provide(
				buildGraph(filename),
				Reactivity.layer
			);
			// Motel-inspired PRAGMA tuning (WAL, cache, mmap, etc.) — must run after Migrator but before service use
			const pragmaLayer = Layer.effectDiscard(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					// These are safe to run even on :memory:; they are no-ops or tuned for file DBs
					yield* sql`PRAGMA journal_mode=WAL`.pipe(Effect.ignore);
					yield* sql`PRAGMA synchronous=NORMAL`.pipe(Effect.ignore);
					yield* sql`PRAGMA cache_size=-65536`.pipe(Effect.ignore);
					yield* sql`PRAGMA mmap_size=268435456`.pipe(Effect.ignore);
					yield* sql`PRAGMA foreign_keys=ON`.pipe(Effect.ignore);
					yield* sql`PRAGMA busy_timeout=15000`.pipe(Effect.ignore);
					yield* sql`PRAGMA analysis_limit=1000`.pipe(Effect.ignore);
					yield* sql`PRAGMA optimize`.pipe(Effect.ignore);
				})
			);
			return Effect.succeed(
				Layer.merge(
					Layer.provide(
						Layer.provide(
							Layer.provide(Layer.effect(TaskStore.Tag, makeService), MigratorLayer),
							Layer.provide(pragmaLayer, client)
						),
						client
					),
					client
				)
			);
		})
	);
	return withMigrations as Layer.Layer<
		TaskStore.Tag,
		TaskError | import('effect/unstable/sql/SqlError').SqlError | import('effect/unstable/sql/Migrator').MigrationError,
		never
	>;
}

// ---------------------------------------------------------------------------
// Codecs (SQL aliases rows to camelCase; Schema decodes/encodes the boundary)
// ---------------------------------------------------------------------------

const SPEC_JSON = Schema.fromJsonString(TaskSpec);
const encodeSpecJson = Schema.encodeSync(SPEC_JSON);
const decodeSpecJson = Schema.decodeSync(SPEC_JSON);

const decodeSpecRowShape = Schema.decodeUnknownSync(
	Schema.Struct({
		revision: Schema.String,
		createdAtMs: Schema.Number,
		specJson: Schema.String
	})
);

const ProfileRow = Schema.Struct({
	id: Schema.String,
	provider: Schema.String,
	model: Schema.String,
	variant: Schema.NullOr(Schema.String)
});
const decodeProfileRow = Schema.decodeUnknownSync(ProfileRow);

const JobRow = Schema.Struct({
	jobId: Schema.String,
	taskId: Schema.String,
	taskRevision: Schema.String,
	blueprintId: Schema.NullOr(Schema.String),
	blueprintHash: Schema.NullOr(Schema.String),
	evaluatorId: Schema.String,
	rubricHash: Schema.String,
	createdAtMs: Schema.Number,
	status: Schema.Literals(['running', 'completed', 'failed', 'cancelled'])
});
const decodeJobRow = Schema.decodeUnknownSync(JobRow);

const TrialStatus = Schema.Literals([
	'pending', 'running', 'scored', 'contract-invalid',
	'llm-error', 'timeout', 'interrupted', 'judge-unavailable'
]);

const TrialRow = Schema.Struct({
	trialId: Schema.String,
	jobId: Schema.String,
	blueprintId: Schema.String,
	blueprintHash: Schema.String,
	taskId: Schema.String,
	taskRevision: Schema.String,
	profileId: Schema.String,
	provider: Schema.String,
	model: Schema.String,
	variant: Schema.NullOr(Schema.String),
	trial: Schema.Number,
	status: TrialStatus,
	outputText: Schema.NullOr(Schema.String),
	outputBytes: Schema.NullOr(Schema.Number),
	outputHash: Schema.NullOr(Schema.String),
	durationMs: Schema.NullOr(Schema.Number),
	tokensIn: Schema.NullOr(Schema.Number),
	tokensOut: Schema.NullOr(Schema.Number),
	sessionId: Schema.NullOr(Schema.String),
	errorReason: Schema.NullOr(Schema.String),
	startedAtMs: Schema.NullOr(Schema.Number),
	finishedAtMs: Schema.NullOr(Schema.Number)
});
const decodeTrialRow = Schema.decodeUnknownSync(TrialRow);

const encodeTrialRecord = Schema.encodeSync(TaskStore.TrialRecord);

const ScoreRow = Schema.Struct({
	scoreId: Schema.String,
	trialId: Schema.String,
	evaluatorId: Schema.String,
	rubricHash: Schema.String,
	deterministicJson: Schema.String,
	dimensionsJson: Schema.String,
	total: Schema.Number,
	scoredAtMs: Schema.Number
});
const decodeScoreRow = Schema.decodeUnknownSync(ScoreRow);

const HistoryRow = Schema.Struct({
	eventId: Schema.Number,
	jobId: Schema.String,
	sequence: Schema.Number,
	kind: Schema.String,
	payloadJson: Schema.String,
	previousHash: Schema.String,
	hash: Schema.String,
	createdAtMs: Schema.Number
});
const decodeHistoryRow = Schema.decodeUnknownSync(HistoryRow);

const HistoryHead = Schema.Struct({
	sequence: Schema.Number,
	hash: Schema.String
});
const decodeHistoryHead = Schema.decodeUnknownSync(HistoryHead);

const TraceHead = Schema.Struct({
	sequence: Schema.Number
});
const decodeTraceHead = Schema.decodeUnknownSync(TraceHead);

const LeadingRow = Schema.Struct({
	jobId: Schema.String,
	trialId: Schema.String,
	total: Schema.Number,
	selectedAtMs: Schema.Number
});
const decodeLeadingRow = Schema.decodeUnknownSync(LeadingRow);

const TraceRow = Schema.Struct({
	trialId: Schema.String,
	sequence: Schema.Number,
	kind: Schema.String,
	payloadJson: Schema.String,
	previousHash: Schema.String,
	hash: Schema.String,
	createdAtMs: Schema.Number
});
const decodeTraceRow = Schema.decodeUnknownSync(TraceRow);

const specFromRow = (
	row: { readonly revision: string; readonly createdAtMs: number; readonly specJson: string }
): Task =>
	new Task({
		revision: row.revision,
		createdAtMs: row.createdAtMs,
		spec: decodeSpecJson(row.specJson)
	});

const profileFromRow = (row: {
	readonly id: string;
	readonly provider: string;
	readonly model: string;
	readonly variant: string | null;
}): ModelProfile =>
	new ModelProfile({
		id: row.id,
		provider: row.provider,
		model: row.model,
		...(row.variant === null ? {} : { variant: row.variant })
	});

const trialFromRow = (row: ReturnType<typeof decodeTrialRow>): TaskStore.TrialRecord =>
	new TaskStore.TrialRecord({
		trialId: row.trialId,
		jobId: row.jobId,
		blueprintId: row.blueprintId,
		blueprintHash: row.blueprintHash,
		taskId: row.taskId,
		taskRevision: row.taskRevision,
		profileId: row.profileId,
		provider: row.provider,
		model: row.model,
		...(row.variant === null ? {} : { variant: row.variant }),
		trial: row.trial,
		status: row.status,
		...(row.outputText === null ? {} : { outputText: row.outputText }),
		...(row.outputBytes === null ? {} : { outputBytes: row.outputBytes }),
		...(row.outputHash === null ? {} : { outputHash: row.outputHash }),
		...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
		...(row.tokensIn === null ? {} : { tokensIn: row.tokensIn }),
		...(row.tokensOut === null ? {} : { tokensOut: row.tokensOut }),
		...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
		...(row.errorReason === null ? {} : { errorReason: row.errorReason }),
		...(row.startedAtMs === null ? {} : { startedAtMs: row.startedAtMs }),
		...(row.finishedAtMs === null ? {} : { finishedAtMs: row.finishedAtMs })
	});

const jobFromRow = (row: ReturnType<typeof decodeJobRow>): TaskStore.JobRecord =>
	new TaskStore.JobRecord({
		jobId: row.jobId,
		taskId: row.taskId,
		taskRevision: row.taskRevision,
		...(row.blueprintId === null ? {} : { blueprintId: row.blueprintId }),
		...(row.blueprintHash === null ? {} : { blueprintHash: row.blueprintHash }),
		evaluatorId: row.evaluatorId,
		rubricHash: row.rubricHash,
		createdAtMs: row.createdAtMs,
		status: row.status
	});

const nullish = <T>(value: T | undefined): T | null => value ?? null;

const fail = (operation: string, reason: string): TaskError =>
	new TaskError({ operation, reason });

const isUniqueViolation = (cause: unknown): boolean =>
	SqlError.isSqlError(cause) && Schema.is(SqlError.UniqueViolation)(cause.reason);

const mapSqlError = (operation: string) => (cause: unknown): TaskError =>
	cause instanceof TaskError ? cause : fail(operation, String(cause));

const seal = (input: {
	readonly sequence: number;
	readonly previousHash: string;
	readonly kind: string;
	readonly payloadJson: string;
	readonly now: number;
}): string =>
	fnv1aHex(JSON.stringify([input.sequence, input.previousHash, input.kind, input.payloadJson, input.now]));

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const LIST_CAP = 200;

const makeService: Effect.Effect<TaskStore.Service, TaskError, SqlClient.SqlClient> =
	Effect.gen(function*() {
		const sql = yield* SqlClient.SqlClient;

		const service: TaskStore.Service = {
			upsertTask: (input: UpsertTaskInput) =>
				sql.withTransaction(
					Effect.gen(function*() {
						const specJson = encodeSpecJson(input.spec);
						const same = yield* sql`SELECT revision, created_at_ms AS "createdAtMs", spec_json AS "specJson"
							FROM task_revisions WHERE revision = ${input.revision} AND task_id = ${input.spec.taskId}`;
						const identical = Option.map(Option.fromNullishOr(same[0]), decodeSpecRowShape);
						if (Option.isSome(identical)) {
							if (identical.value.specJson !== specJson) {
								return yield* Effect.fail(
									fail('upsertTask', `revision ${input.revision} does not match its existing content`)
								);
							}
							return specFromRow(identical.value);
						}
						const existing = yield* sql`SELECT id FROM tasks WHERE id = ${input.spec.taskId}`;
						yield* Option.match(Option.fromNullishOr(existing[0]), {
							onNone: () =>
								sql`INSERT INTO tasks (id, title, domain, current_revision, updated_at_ms)
									VALUES (${input.spec.taskId}, ${input.spec.title}, ${input.spec.domain}, ${input.revision}, ${input.now})`,
							onSome: () =>
								sql`UPDATE tasks SET title = ${input.spec.title}, domain = ${input.spec.domain},
									current_revision = ${input.revision}, updated_at_ms = ${input.now} WHERE id = ${input.spec.taskId}`
						});
						yield* sql`INSERT INTO task_revisions (revision, task_id, spec_json, created_at_ms)
							VALUES (${input.revision}, ${input.spec.taskId}, ${specJson}, ${input.now})`;
						return specFromRow({ revision: input.revision, createdAtMs: input.now, specJson });
					})
				).pipe(Effect.mapError(mapSqlError('upsertTask'))),

			getTask: (taskId) =>
				Effect.map(
					sql`SELECT r.revision, r.created_at_ms AS "createdAtMs", r.spec_json AS "specJson"
						FROM tasks t JOIN task_revisions r ON r.revision = t.current_revision
						WHERE t.id = ${taskId}`,
					(rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => specFromRow(decodeSpecRowShape(row)))
				).pipe(Effect.mapError(mapSqlError('getTask'))),

			listTasks: (cursor) =>
				Effect.gen(function*() {
					const LIMIT = 50;
					const rows = cursor === undefined
						? yield* sql`SELECT r.revision, r.created_at_ms AS "createdAtMs", r.spec_json AS "specJson", t.id AS "taskId"
							FROM tasks t JOIN task_revisions r ON r.revision = t.current_revision
							ORDER BY t.id LIMIT ${LIMIT + 1}`
						: yield* sql`SELECT r.revision, r.created_at_ms AS "createdAtMs", r.spec_json AS "specJson", t.id AS "taskId"
							FROM tasks t JOIN task_revisions r ON r.revision = t.current_revision
							WHERE t.id > ${cursor} ORDER BY t.id LIMIT ${LIMIT + 1}`;
					const tasks = rows.map((row) => specFromRow(decodeSpecRowShape(row)));
					const hasNext = tasks.length > LIMIT;
					const page = hasNext ? tasks.slice(0, LIMIT) : tasks;
					return {
						items: page,
						nextCursor: hasNext
							? Option.map(Option.fromNullishOr(page[LIMIT - 1]), (task) => task.spec.taskId)
							: Option.none()
					};
				}).pipe(Effect.mapError(mapSqlError('listTasks'))),

			upsertProfile: (profile) =>
				Effect.gen(function*() {
					const now = yield* Clock.currentTimeMillis;
					yield* sql`INSERT INTO model_profiles (id, provider, model, variant, created_at_ms)
						VALUES (${profile.id}, ${profile.provider}, ${profile.model}, ${nullish(profile.variant)}, ${now})
						ON CONFLICT(id) DO UPDATE SET provider = excluded.provider,
						model = excluded.model, variant = excluded.variant`;
				}).pipe(Effect.mapError(mapSqlError('upsertProfile'))),

			listProfiles: () =>
				Effect.map(
					sql`SELECT id, provider, model, variant FROM model_profiles ORDER BY id LIMIT ${LIST_CAP}`,
					(rows) => rows.map((row) => profileFromRow(decodeProfileRow(row)))
				).pipe(Effect.mapError(mapSqlError('listProfiles'))),

			getProfile: (profileId) =>
				Effect.map(
					sql`SELECT id, provider, model, variant FROM model_profiles WHERE id = ${profileId}`,
					(rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => profileFromRow(decodeProfileRow(row)))
				).pipe(Effect.mapError(mapSqlError('getProfile'))),

			createJob: (input: CreateJobInput) =>
				Effect.gen(function*() {
					const task = yield* sql`SELECT revision FROM task_revisions
						WHERE task_id = ${input.taskId} AND revision = ${input.taskRevision}`;
					if (task.length === 0) {
						return yield* Effect.fail(
							fail('createJob', `task revision ${input.taskRevision} does not belong to ${input.taskId}`)
						);
					}
					yield* sql`INSERT INTO benchmark_jobs
						(job_id, task_id, task_revision, blueprint_id, blueprint_hash, evaluator_id, rubric_hash, created_at_ms, status)
						VALUES (${input.jobId}, ${input.taskId}, ${input.taskRevision},
							${nullish(input.blueprintId)}, ${nullish(input.blueprintHash)},
							${input.evaluatorId}, ${input.rubricHash}, ${input.now}, 'running')`;
					return new TaskStore.JobRecord({
						jobId: input.jobId,
						taskId: input.taskId,
						taskRevision: input.taskRevision,
						...(input.blueprintId !== undefined ? { blueprintId: input.blueprintId } : {}),
						...(input.blueprintHash !== undefined ? { blueprintHash: input.blueprintHash } : {}),
						evaluatorId: input.evaluatorId,
						rubricHash: input.rubricHash,
						createdAtMs: input.now,
						status: 'running'
					});
				}).pipe(Effect.mapError(mapSqlError('createJob'))),

			getJob: (jobId) =>
				Effect.map(
					sql`SELECT job_id AS "jobId", task_id AS "taskId", task_revision AS "taskRevision",
						blueprint_id AS "blueprintId", blueprint_hash AS "blueprintHash",
						evaluator_id AS "evaluatorId", rubric_hash AS "rubricHash",
						created_at_ms AS "createdAtMs", status
						FROM benchmark_jobs WHERE job_id = ${jobId}`,
					(rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => jobFromRow(decodeJobRow(row)))
				).pipe(Effect.mapError(mapSqlError('getJob'))),

			createTrials: (trials) =>
				sql.withTransaction(Effect.forEach(
					trials,
					(trial) =>
						Effect.gen(function*() {
							const e = encodeTrialRecord(trial);
							yield* sql`INSERT INTO benchmark_trials
								(trial_id, job_id, blueprint_id, blueprint_hash, task_id, task_revision,
								 profile_id, provider, model, variant, trial, status,
								 output_text, output_bytes, output_hash, duration_ms, tokens_in, tokens_out,
								 session_id, error_reason, started_at_ms, finished_at_ms)
								VALUES (
									${nullish(e.trialId)}, ${nullish(e.jobId)}, ${nullish(e.blueprintId)},
									${nullish(e.blueprintHash)}, ${nullish(e.taskId)}, ${nullish(e.taskRevision)},
									${nullish(e.profileId)}, ${nullish(e.provider)}, ${nullish(e.model)},
									${nullish(e.variant)}, ${nullish(e.trial)}, ${nullish(e.status)},
									${nullish(e.outputText)}, ${nullish(e.outputBytes)}, ${nullish(e.outputHash)},
									${nullish(e.durationMs)}, ${nullish(e.tokensIn)}, ${nullish(e.tokensOut)},
									${nullish(e.sessionId)}, ${nullish(e.errorReason)},
									${nullish(e.startedAtMs)}, ${nullish(e.finishedAtMs)}
								)`;
						}),
					{ concurrency: 1, discard: true }
				)).pipe(
					Effect.mapError((cause): TaskError =>
						isUniqueViolation(cause)
							? fail('createTrials', 'duplicate trial identity')
							: fail('createTrials', String(cause))
					)
				),

			completeTrial: (outcome: TrialOutcome) =>
				sql.withTransaction(
					Effect.gen(function*() {
						const updated = yield* sql`UPDATE benchmark_trials SET
								status = ${outcome.status},
								output_text = ${nullish(outcome.outputText)},
								output_bytes = ${nullish(outcome.outputBytes)},
								output_hash = ${nullish(outcome.outputHash)},
								duration_ms = ${nullish(outcome.durationMs)},
								tokens_in = ${nullish(outcome.tokensIn)},
								tokens_out = ${nullish(outcome.tokensOut)},
								session_id = ${nullish(outcome.sessionId)},
								error_reason = ${nullish(outcome.errorReason)},
								finished_at_ms = ${outcome.finishedAtMs}
							WHERE trial_id = ${outcome.trialId} AND status = 'pending'
							RETURNING trial_id AS "trialId", job_id AS "jobId", blueprint_id AS "blueprintId",
								blueprint_hash AS "blueprintHash", task_id AS "taskId", task_revision AS "taskRevision",
								profile_id AS "profileId", provider, model, variant, trial, status,
								output_text AS "outputText", output_bytes AS "outputBytes", output_hash AS "outputHash",
								duration_ms AS "durationMs", tokens_in AS "tokensIn", tokens_out AS "tokensOut",
								session_id AS "sessionId", error_reason AS "errorReason",
								started_at_ms AS "startedAtMs", finished_at_ms AS "finishedAtMs"`;
						const record = Option.map(Option.fromNullishOr(updated[0]), (row) =>
							trialFromRow(decodeTrialRow(row)));
					// A duplicate completion returns no updated row; do not append
					// a second score in that case.
					yield* Option.match(record, {
						onNone: () => Effect.void,
						onSome: () =>
							Option.match(Option.fromNullishOr(outcome.score), {
								onNone: () => Effect.void,
								onSome: (score) =>
									sql`INSERT INTO trial_scores
										(score_id, trial_id, evaluator_id, rubric_hash, deterministic_json, dimensions_json, total, scored_at_ms)
										VALUES (${score.scoreId}, ${outcome.trialId}, ${score.evaluatorId}, ${score.rubricHash},
											${score.deterministicJson}, ${score.dimensionsJson}, ${score.total}, ${score.now})`
											.pipe(Effect.mapError(mapSqlError('completeTrial')))
							})
					});
						return record;
					})
				).pipe(Effect.mapError(mapSqlError('completeTrial'))),

			listTrials: (jobId) =>
				Effect.map(
					sql`SELECT trial_id AS "trialId", job_id AS "jobId", blueprint_id AS "blueprintId",
						blueprint_hash AS "blueprintHash", task_id AS "taskId", task_revision AS "taskRevision",
						profile_id AS "profileId", provider, model, variant, trial, status,
						output_text AS "outputText", output_bytes AS "outputBytes", output_hash AS "outputHash",
						duration_ms AS "durationMs", tokens_in AS "tokensIn", tokens_out AS "tokensOut",
						session_id AS "sessionId", error_reason AS "errorReason",
						started_at_ms AS "startedAtMs", finished_at_ms AS "finishedAtMs"
						FROM benchmark_trials WHERE job_id = ${jobId} ORDER BY profile_id, trial LIMIT ${LIST_CAP}`,
					(rows) => rows.map((row) => trialFromRow(decodeTrialRow(row)))
				).pipe(Effect.mapError(mapSqlError('listTrials'))),

			listAllTrials: (jobId) =>
				Effect.map(
					sql`SELECT trial_id AS "trialId", job_id AS "jobId", blueprint_id AS "blueprintId",
						blueprint_hash AS "blueprintHash", task_id AS "taskId", task_revision AS "taskRevision",
						profile_id AS "profileId", provider, model, variant, trial, status,
						output_text AS "outputText", output_bytes AS "outputBytes", output_hash AS "outputHash",
						duration_ms AS "durationMs", tokens_in AS "tokensIn", tokens_out AS "tokensOut",
						session_id AS "sessionId", error_reason AS "errorReason",
						started_at_ms AS "startedAtMs", finished_at_ms AS "finishedAtMs"
						FROM benchmark_trials WHERE job_id = ${jobId} ORDER BY profile_id, trial`,
					(rows) => rows.map((row) => trialFromRow(decodeTrialRow(row)))
				).pipe(Effect.mapError(mapSqlError('listAllTrials'))),

			listScores: (jobId) =>
				Effect.map(
					sql`SELECT s.score_id AS "scoreId", s.trial_id AS "trialId", s.evaluator_id AS "evaluatorId",
						s.rubric_hash AS "rubricHash", s.deterministic_json AS "deterministicJson",
						s.dimensions_json AS "dimensionsJson", s.total, s.scored_at_ms AS "scoredAtMs"
						FROM trial_scores s JOIN benchmark_trials t ON t.trial_id = s.trial_id
						WHERE t.job_id = ${jobId} ORDER BY s.scored_at_ms LIMIT ${LIST_CAP}`,
					(rows) => rows.map((row) => new TaskStore.ScoreRecord(decodeScoreRow(row)))
				).pipe(Effect.mapError(mapSqlError('listScores'))),

			listAllScores: (jobId) =>
				Effect.map(
					sql`SELECT s.score_id AS "scoreId", s.trial_id AS "trialId", s.evaluator_id AS "evaluatorId",
						s.rubric_hash AS "rubricHash", s.deterministic_json AS "deterministicJson",
						s.dimensions_json AS "dimensionsJson", s.total, s.scored_at_ms AS "scoredAtMs"
						FROM trial_scores s JOIN benchmark_trials t ON t.trial_id = s.trial_id
						WHERE t.job_id = ${jobId} ORDER BY s.scored_at_ms`,
					(rows) => rows.map((row) => new TaskStore.ScoreRecord(decodeScoreRow(row)))
				).pipe(Effect.mapError(mapSqlError('listAllScores'))),

			completeJob: (input: CompleteJobInput) =>
				sql.withTransaction(
					Effect.gen(function*() {
						const pending = yield* sql`SELECT trial_id FROM benchmark_trials
							WHERE job_id = ${input.jobId} AND status = 'pending' LIMIT 1`;
						if (pending.length > 0) {
							return yield* Effect.fail(fail('completeJob', `job ${input.jobId} still has pending trials`));
						}
						const updated = yield* sql`UPDATE benchmark_jobs SET status = ${input.status}
							WHERE job_id = ${input.jobId} AND status = 'running'
							RETURNING job_id`;
						if (updated.length === 0) {
							return yield* Effect.fail(fail('completeJob', `job ${input.jobId} is missing or already terminal`));
						}
						yield* Option.match(Option.fromNullishOr(input.leading), {
							onNone: () => Effect.void,
							onSome: (leading) =>
								sql`INSERT INTO leading_solutions (job_id, trial_id, total, selected_at_ms)
									SELECT ${input.jobId}, trial_id, ${leading.total}, ${input.now}
									FROM benchmark_trials
									WHERE job_id = ${input.jobId} AND trial_id = ${leading.trialId}
									RETURNING trial_id`
										.pipe(Effect.flatMap((rows) =>
											rows.length === 0
												? Effect.fail(fail('completeJob', `leading trial ${leading.trialId} does not belong to ${input.jobId}`))
												: Effect.void
										), Effect.mapError(mapSqlError('completeJob')))
						});
						const head = yield* sql`SELECT sequence, hash FROM benchmark_history
							WHERE job_id = ${input.jobId} ORDER BY sequence DESC LIMIT 1`;
						const last = Option.map(Option.fromNullishOr(head[0]), decodeHistoryHead);
						const sequence = Option.match(last, {
							onNone: () => 0,
							onSome: (row) => row.sequence + 1
						});
						const previousHash = Option.match(last, {
							onNone: () => 'genesis',
							onSome: (row) => row.hash
						});
						yield* sql`INSERT INTO benchmark_history
							(job_id, sequence, kind, payload_json, previous_hash, hash, created_at_ms)
							VALUES (${input.jobId}, ${sequence}, ${input.history.kind}, ${input.history.payloadJson},
								${previousHash}, ${seal({ sequence, previousHash, kind: input.history.kind, payloadJson: input.history.payloadJson, now: input.now })},
								${input.now})`;
					})
				).pipe(Effect.mapError(mapSqlError('completeJob'))),

			getLeading: (jobId) =>
				Effect.map(
					sql`SELECT job_id AS "jobId", trial_id AS "trialId", total, selected_at_ms AS "selectedAtMs"
						FROM leading_solutions WHERE job_id = ${jobId}`,
					(rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => new TaskStore.LeadingRecord(decodeLeadingRow(row)))
				).pipe(Effect.mapError(mapSqlError('getLeading'))),

			appendHistory: (input: HistoryInput) =>
				sql.withTransaction(
					Effect.gen(function*() {
						const head = yield* sql`SELECT sequence, hash FROM benchmark_history
							WHERE job_id = ${input.jobId} ORDER BY sequence DESC LIMIT 1`;
						const last = Option.map(Option.fromNullishOr(head[0]), decodeHistoryHead);
						const sequence = Option.match(last, {
							onNone: () => 0,
							onSome: (row) => row.sequence + 1
						});
						const previousHash = Option.match(last, {
							onNone: () => 'genesis',
							onSome: (row) => row.hash
						});
						const hash = seal({
							sequence,
							previousHash,
							kind: input.kind,
							payloadJson: input.payloadJson,
							now: input.now
						});
						yield* sql`INSERT INTO benchmark_history
							(job_id, sequence, kind, payload_json, previous_hash, hash, created_at_ms)
							VALUES (${input.jobId}, ${sequence}, ${input.kind}, ${input.payloadJson},
								${previousHash}, ${hash}, ${input.now})`;
						return new TaskStore.HistoryRecord({
							eventId: sequence,
							jobId: input.jobId,
							sequence,
							kind: input.kind,
							payloadJson: input.payloadJson,
							previousHash,
							hash,
							createdAtMs: input.now
						});
					})
				).pipe(Effect.mapError(mapSqlError('appendHistory'))),

			listHistory: (jobId) =>
				Effect.map(
					sql`SELECT event_id AS "eventId", job_id AS "jobId", sequence, kind,
						payload_json AS "payloadJson", previous_hash AS "previousHash", hash,
						created_at_ms AS "createdAtMs"
						FROM benchmark_history WHERE job_id = ${jobId} ORDER BY sequence`,
					(rows) => {
						const records = rows.map((row) => new TaskStore.HistoryRecord(decodeHistoryRow(row)));
						const brokenAt = records.findIndex((record, index) => {
							if (record.sequence !== index) return true;
							const expected = seal({
								sequence: record.sequence,
								previousHash: record.previousHash,
								kind: record.kind,
								payloadJson: record.payloadJson,
								now: record.createdAtMs
							});
							if (record.hash !== expected) return true;
							const previous = index === 0 ? 'genesis' : (records[index - 1]?.hash ?? '');
							return record.previousHash !== previous;
						});
						return brokenAt === -1
							? Effect.succeed(records)
							: Effect.fail(fail('listHistory', `broken history chain at event ${String(brokenAt)}`));
					}
				).pipe(Effect.flatten, Effect.mapError(mapSqlError('listHistory'))),

			recordTrace: (input) =>
				Effect.gen(function*() {
					const now = input.now;
					const head = yield* sql`SELECT sequence, hash FROM benchmark_trace_events_v2
						WHERE trial_id = ${input.trialId} ORDER BY sequence DESC LIMIT 1`;
					const last = Option.map(Option.fromNullishOr(head[0]), (row) =>
						Schema.decodeUnknownSync(Schema.Struct({ sequence: Schema.Number, hash: Schema.String }))(row));
					const sequence = Option.match(last, { onNone: () => 0, onSome: (row) => row.sequence + 1 });
					const previousHash = Option.match(last, { onNone: () => 'genesis', onSome: (row) => row.hash });
					const hash = seal({ sequence, previousHash, kind: input.kind, payloadJson: input.payloadJson, now });
					yield* sql`INSERT INTO benchmark_trace_events_v2
						(trial_id, sequence, kind, payload_json, previous_hash, hash, created_at_ms)
						VALUES (${input.trialId}, ${sequence}, ${input.kind}, ${input.payloadJson}, ${previousHash}, ${hash}, ${now})`;
					return new TaskStore.TraceRecord({
						trialId: input.trialId,
						sequence,
						kind: input.kind,
						payloadJson: input.payloadJson,
						previousHash,
						hash,
						createdAtMs: now
					});
				}).pipe(Effect.mapError(mapSqlError('recordTrace'))),

			listTrace: (trialId) =>
				Effect.map(
					sql`SELECT trial_id AS "trialId", sequence, kind, payload_json AS "payloadJson",
						previous_hash AS "previousHash", hash, created_at_ms AS "createdAtMs"
						FROM benchmark_trace_events_v2 WHERE trial_id = ${trialId} ORDER BY sequence`,
					(rows) => {
						const records = rows.map((row) => new TaskStore.TraceRecord(decodeTraceRow(row)));
						const brokenAt = records.findIndex((record, index) => {
							if (record.sequence !== index) return true;
							const expected = seal({
								sequence: record.sequence,
								previousHash: record.previousHash,
								kind: record.kind,
								payloadJson: record.payloadJson,
								now: record.createdAtMs
							});
							if (record.hash !== expected) return true;
							const previous = index === 0 ? 'genesis' : (records[index - 1]?.hash ?? '');
							return record.previousHash !== previous;
						});
						return brokenAt === -1
							? Effect.succeed(records)
							: Effect.fail(fail('listTrace', `broken trace chain at event ${String(brokenAt)}`));
					}
				).pipe(Effect.flatten, Effect.mapError(mapSqlError('listTrace')))
		};

		return service;
	});

interface SpecRow {
	readonly revision: string;
	readonly createdAtMs: number;
	readonly specJson: string;
}
