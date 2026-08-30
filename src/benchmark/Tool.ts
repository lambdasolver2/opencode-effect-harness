/**
 * BenchmarkTool — typed operations behind `effect_harness_compound` (spec 06
 * §7). Wires the TaskStore SQLite adapter, the OpenCode session executor, and
 * the BenchmarkRunner into one schema-validated op surface.
 *
 * Design (types over ifs):
 *  - the input union is Schema-validated with bounded numbers and non-empty
 *    candidate lists — clamping `if`s are unrepresentable;
 *  - dispatch is a Match on the tagged union, exhaustive by construction;
 *  - single-entity getters return Option — "not found" is a value;
 *  - `task.create` upserts: identical revisions are idempotent, changed specs
 *    create a NEW immutable revision;
 *  - `task.update` merges fields onto the CURRENT revision (new revision id);
 *  - configured `compound.benchmark.models` are seeded (idempotent upsert)
 *    before every benchmark start;
 *  - the handler is TOTAL: expected domain failures return a structured
 *    `error` result, they never fabricate success;
 *  - mine-evolve keeps the honest REM-4 boundary.
 */
import { Clock, Effect, FileSystem, Layer, Match, Option, Schema } from 'effect';

import { ModelProfile, Slug, Task, TaskConstraints, TaskError, TaskSpec } from 'opencode-compound-kit/Task.ts';
import { TaskStore } from 'opencode-compound-kit/task/Store.ts';
import { fnv1aHex } from 'opencode-harness-shared/Hash.ts';

import { Runner, type RunSummary } from './Runner.ts';
import { Executor } from '../session/Executor.ts';
import type { ValidOptions } from '../Options.ts';
import { SqliteStore } from 'opencode-bench-store';

// ---------------------------------------------------------------------------
// Input contract (bounded numbers + non-empty lists — no clamping ifs needed)
// ---------------------------------------------------------------------------

const Bounded = (minimum: number, maximum: number) =>
	Schema.Finite.check(Schema.isBetween({ minimum, maximum }));

const ModelProfileInput = Schema.Struct({
	id: Slug,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	variant: Schema.optionalKey(Schema.NonEmptyString)
});

const withOp = <L extends string, Fields extends Schema.Struct.Fields>(
	value: L,
	fields: Fields
) =>
	Schema.Struct({ op: Schema.Literal(value), ...fields });

export const BenchmarkInput = Schema.Union([
	withOp('task.create', {
			id: Slug,
			title: Schema.NonEmptyString,
			domain: Schema.NonEmptyString,
			problem: Schema.NonEmptyString,
			rubric: Schema.NonEmptyString,
			evaluatorId: Schema.optionalKey(Schema.String),
			referenceSolution: Schema.optionalKey(Schema.String),
			modelProfileIds: Schema.NonEmptyArray(Slug),
			prompt: Schema.optionalKey(Schema.NonEmptyString),
			maxOutputChars: Schema.optionalKey(Bounded(500, 500_000)),
			maxSnippets: Schema.optionalKey(Bounded(1, 20))
	}),
	withOp('task.update', {
			id: Slug,
			problem: Schema.optionalKey(Schema.NonEmptyString),
			rubric: Schema.optionalKey(Schema.NonEmptyString),
			referenceSolution: Schema.optionalKey(Schema.String),
			modelProfileIds: Schema.optionalKey(Schema.NonEmptyArray(Slug)),
			prompt: Schema.optionalKey(Schema.NonEmptyString)
	}),
	withOp('task.get', { id: Slug }),
	withOp('task.list', { cursor: Schema.optionalKey(Schema.String) }),
	withOp('profile.add', ModelProfileInput.fields),
	withOp('profile.list', {}),
	withOp('benchmark.start', {
		taskId: Slug,
		trials: Schema.optionalKey(Bounded(1, 5)),
		concurrency: Schema.optionalKey(Bounded(1, 16)),
		judgeProfileId: Schema.optionalKey(Slug)
	}),
	withOp('benchmark.status', { jobId: Schema.String }),
	withOp('benchmark.leading', { jobId: Schema.String }),
	withOp('benchmark.history', { jobId: Schema.String }),
	withOp('benchmark.trial', { trialId: Schema.String }),
	withOp('mine-evolve', {})
]);

const decodeInput = Schema.decodeUnknownSync(BenchmarkInput);

// ---------------------------------------------------------------------------
// Result payload (tool result carries a Schema-encoded JSON string)
// ---------------------------------------------------------------------------

export interface BenchmarkToolResult {
	readonly status: 'ok' | 'error';
	readonly content: string;
}

const OkPayload = Schema.Struct({ kind: Schema.Literals(['ok']), data: Schema.Unknown });
const ErrorPayload = Schema.Struct({ kind: Schema.Literals(['error']), reason: Schema.String });
const ResultPayload = Schema.Union([OkPayload, ErrorPayload]);

const RESULT_CODEC = Schema.fromJsonString(ResultPayload);
const encodeResult = Schema.encodeSync(RESULT_CODEC);
const decodeResult = Schema.decodeSync(RESULT_CODEC);

const ok = (data: unknown): BenchmarkToolResult => ({
	status: 'ok',
	content: encodeResult({ kind: 'ok', data })
});

const err = (reason: string): BenchmarkToolResult => ({
	status: 'error',
	content: encodeResult({ kind: 'error', reason: reason.slice(0, 400) })
});

export const renderResult = (result: BenchmarkToolResult): string => {
	const decoded = decodeResult(result.content);
	return decoded.kind === 'error' ? `error: ${decoded.reason}` : 'ok';
};

// ---------------------------------------------------------------------------
// Host deps
// ---------------------------------------------------------------------------

export interface BenchmarkToolDeps {
	readonly benchmark: ValidOptions['compound']['benchmark'];
	readonly projectRoot: string;
	readonly executor: Executor.Service;
	readonly workspaceDirFor: (label: string) => Effect.Effect<string, TaskError>;
	readonly cleanupWorkspace: (dir: string) => Effect.Effect<void>;
	readonly withStore: <A>(
		effect: Effect.Effect<A, TaskError, TaskStore.Tag>
	) => Effect.Effect<A, TaskError>;
}

export const benchmarkStoreLayer = (
	filename: import('opencode-bench-store').SqliteStore.DbFilename,
	platform: Layer.Layer<import('effect').FileSystem.FileSystem | import('effect').Path.Path, never, never>
) =>
	Match.value(filename).pipe(
		Match.when({ _tag: 'Memory' }, () => SqliteStore.layer({ _tag: 'Memory' })),
		Match.when({ _tag: 'File' }, (file) => SqliteStore.layer(file, platform)),
		Match.exhaustive
	);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export namespace BenchmarkTool {
	const SPEC_JSON = Schema.fromJsonString(TaskSpec);
	const revisionOf = (spec: TaskSpec): string =>
		fnv1aHex(Schema.encodeSync(SPEC_JSON)(spec));

	class TaskView extends Schema.Class<TaskView>('TaskView')({
		id: Schema.String,
		revision: Schema.String,
		title: Schema.String,
		domain: Schema.String,
		evaluatorId: Schema.String,
		modelProfileIds: Schema.Array(Schema.String),
		hasReferenceSolution: Schema.Boolean,
		hasPrompt: Schema.optionalKey(Schema.Boolean)
	}) {}
	const encodeTaskView = Schema.encodeSync(TaskView);
	const viewOf = (task: Task) =>
		encodeTaskView(
			new TaskView({
				id: task.spec.taskId,
				revision: task.revision,
				title: task.spec.title,
				domain: task.spec.domain,
				evaluatorId: task.spec.evaluatorId,
				modelProfileIds: [...task.spec.modelProfileIds],
				hasReferenceSolution: task.spec.referenceSolution !== undefined,
				...(task.spec.prompt !== undefined ? { hasPrompt: true } : {})
			})
		);

	const fail = (reason: string): TaskError =>
		new TaskError({ operation: 'tool', reason });

	const buildConstraints = (input: {
		readonly maxOutputChars?: number | undefined;
		readonly maxSnippets?: number | undefined;
	}): TaskConstraints =>
		new TaskConstraints({
			maxOutputChars: input.maxOutputChars ?? 8000,
			...(input.maxSnippets !== undefined ? { maxSnippets: input.maxSnippets } : {})
		});

	const buildSpec = (input: {
		readonly id: string;
		readonly title: string;
		readonly domain: string;
		readonly problem: string;
		readonly rubric: string;
		readonly evaluatorId?: string | undefined;
		readonly referenceSolution?: string | undefined;
		readonly modelProfileIds: readonly [string, ...string[]];
		readonly prompt?: string | undefined;
		readonly maxOutputChars?: number | undefined;
		readonly maxSnippets?: number | undefined;
	}): TaskSpec =>
		new TaskSpec({
			taskId: input.id,
			title: input.title,
			domain: input.domain,
			problem: input.problem,
			evaluatorId: input.evaluatorId ?? 'design-brief@1',
			rubric: input.rubric,
			...(input.referenceSolution !== undefined ? { referenceSolution: input.referenceSolution } : {}),
			...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
			modelProfileIds: input.modelProfileIds,
			constraints: buildConstraints(input)
		});

	/** Idempotently seed the configured model profiles before benchmark ops. */
	const seedProfiles = (deps: BenchmarkToolDeps) =>
		deps.withStore(
			Effect.forEach(
				deps.benchmark.models,
				(model) =>
					TaskStore.Tag.pipe(
						Effect.flatMap((store) =>
							store.upsertProfile(
								new ModelProfile({
									id: model.id,
									provider: model.provider,
									model: model.model,
									...(model.variant !== undefined ? { variant: model.variant } : {})
								})
							)
						)
					),
				{ concurrency: 1, discard: true }
			)
		);

	const startBenchmark = (
		deps: BenchmarkToolDeps,
		fields: {
			readonly taskId: string;
			readonly trials?: number | undefined;
			readonly concurrency?: number | undefined;
			readonly judgeProfileId?: string | undefined;
		}
	): Effect.Effect<BenchmarkToolResult, TaskError> =>
		Effect.flatMap(seedProfiles(deps), () =>
			deps.withStore(
				Effect.gen(function*() {
					const store = yield* TaskStore.Tag;
					const taskOption = yield* store.getTask(fields.taskId);
					const task = Option.match(taskOption, {
						onNone: () => null,
						onSome: (value) => value
					});
					if (task === null) {
						return yield* Effect.fail(fail(`unknown task ${fields.taskId}`));
					}
					const judgeProfileId = fields.judgeProfileId ?? deps.benchmark.judgeProfileId;
					const judgeProfileOption =
						judgeProfileId === undefined ? Option.none() : yield* store.getProfile(judgeProfileId);
					if (judgeProfileId !== undefined && Option.isNone(judgeProfileOption)) {
						return yield* Effect.fail(fail(`unknown judge profile ${judgeProfileId}`));
					}
					const resolved = yield* Effect.forEach(
						task.spec.modelProfileIds,
						(profileId) => store.getProfile(profileId),
						{ concurrency: 1 }
					);
					const profiles = resolved.flatMap((profileOption) =>
						Option.match(profileOption, {
							onNone: () => [],
							onSome: (profile) => [profile]
						})
					);
					// Unknown profiles FAIL instead of being silently dropped.
					const missing = task.spec.modelProfileIds.filter(
						(id) => !profiles.some((profile) => profile.id === id)
					);
					if (profiles.length === 0 || missing.length > 0) {
						return yield* Effect.fail(
							fail(
								`profiles not resolvable for ${fields.taskId}: ${missing.join(', ') || '(none configured)'}; add via profile.add or compound.benchmark.models`
							)
						);
					}
					const trials = fields.trials ?? 1;
					const concurrency = Math.min(
						fields.concurrency ?? deps.benchmark.concurrency,
						deps.benchmark.concurrency
					);
					const summary: RunSummary = yield* Runner.run(
						{
							store,
							executor: deps.executor,
							...(Option.isSome(judgeProfileOption) ? { judgeProfile: judgeProfileOption.value } : {}),
							workspaceDirFor: deps.workspaceDirFor,
							cleanupWorkspace: deps.cleanupWorkspace,
							workerAgent: deps.benchmark.workerAgent,
							timeoutMs: deps.benchmark.timeoutMs
						},
						{ task, profiles, trials, concurrency }
					);
					return ok({
						jobId: summary.jobId,
						outcomes: [...summary.outcomes],
						...(summary.leadingTrialId !== undefined
							? {
								leadingTrialId: summary.leadingTrialId,
								leadingTotal: summary.leadingTotal
							}
							: {})
					});
				})
			)
		);

	const handleOp = (
		deps: BenchmarkToolDeps,
		op: Schema.Schema.Type<typeof BenchmarkInput>
	): Effect.Effect<BenchmarkToolResult, TaskError> =>
		Match.value(op).pipe(
			Match.when({ op: 'mine-evolve' }, () =>
				Effect.fail(
					new TaskError({
						operation: 'mine-evolve',
						reason:
							'mine-evolve is not implemented yet (REM-4 pending). Nothing was read or persisted.'
					})
				)
			),
			Match.when({ op: 'task.create' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const spec = buildSpec(fields);
						const task = yield* store.upsertTask({
							spec,
							revision: revisionOf(spec),
							now: yield* Clock.currentTimeMillis
						});
						return ok({
							taskId: task.spec.taskId,
							evaluatorId: task.spec.evaluatorId,
							receivedEvaluatorId: Reflect.get(fields, "evaluatorId"),
							view: viewOf(task)
						});
					})
				)
			),
			Match.when({ op: 'task.update' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const taskOption = yield* store.getTask(fields.id);
						const current = Option.match(taskOption, {
							onNone: () => null,
							onSome: (value) => value
						});
						if (current === null) {
							return yield* Effect.fail(fail(`unknown task ${fields.id}`));
						}
						const spec = new TaskSpec({
							...current.spec,
							problem: fields.problem ?? current.spec.problem,
							rubric: fields.rubric ?? current.spec.rubric,
							...(fields.referenceSolution !== undefined
								? { referenceSolution: fields.referenceSolution }
								: current.spec.referenceSolution !== undefined
									? { referenceSolution: current.spec.referenceSolution }
									: {}),
							...(fields.modelProfileIds !== undefined
								? { modelProfileIds: fields.modelProfileIds }
								: {}),
							...(fields.prompt !== undefined ? { prompt: fields.prompt } : current.spec.prompt !== undefined ? { prompt: current.spec.prompt } : {})
						});
						const task = yield* store.upsertTask({
							spec,
							revision: revisionOf(spec),
							now: yield* Clock.currentTimeMillis
						});
						return ok(viewOf(task));
					})
				)
			),
			Match.when({ op: 'task.get' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const taskOption = yield* store.getTask(fields.id);
						return Option.match(taskOption, {
							onNone: () => err(`unknown task ${fields.id}`),
							onSome: (task) => ok(viewOf(task))
						});
					})
				)
			),
			Match.when({ op: 'task.list' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const page = yield* store.listTasks(fields.cursor);
						return ok({
							items: page.items.map(viewOf),
							...(Option.isSome(page.nextCursor) ? { nextCursor: page.nextCursor.value } : {})
						});
					})
				)
			),
			Match.when({ op: 'profile.add' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const profile = new ModelProfile({
							id: fields.id,
							provider: fields.provider,
							model: fields.model,
							...(fields.variant !== undefined ? { variant: fields.variant } : {})
						});
						yield* store.upsertProfile(profile);
						return ok({ id: profile.id });
					})
				)
			),
			Match.when({ op: 'profile.list' }, () =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						return ok({ items: [...(yield* store.listProfiles())] });
					})
				)
			),
			Match.when({ op: 'benchmark.start' }, (fields) => startBenchmark(deps, fields)),
			Match.when({ op: 'benchmark.status' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const jobOption = yield* store.getJob(fields.jobId);
						if (Option.isNone(jobOption)) {
							return err(`unknown job ${fields.jobId}`);
						}
						const job = jobOption.value;
						const trials = yield* store.listTrials(fields.jobId);
						const scores = yield* store.listScores(fields.jobId);
						const scoreByTrial = new Map(
							scores.map((score) => [score.trialId, score.total] as const)
						);
						return ok({
							jobId: job.jobId,
							status: job.status,
							trials: trials.map((trial) => {
								const total = scoreByTrial.get(trial.trialId);
								return {
									trialId: trial.trialId,
									profileId: trial.profileId,
									model: `${trial.provider}/${trial.model}`,
									variant: trial.variant ?? null,
									trial: trial.trial,
									status: trial.status,
									scoreTotal: total ?? null
								};
							})
						});
					})
				)
			),
			Match.when({ op: 'benchmark.leading' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const leadingOption = yield* store.getLeading(fields.jobId);
						return Option.match(leadingOption, {
							onNone: () => err(`no leading solution recorded for ${fields.jobId}`),
							onSome: (leading) =>
								ok({
									jobId: leading.jobId,
									trialId: leading.trialId,
									total: leading.total
								})
						});
					})
				)
			),
			Match.when({ op: 'benchmark.history' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						const history = yield* store.listHistory(fields.jobId);
						return ok({
							items: history.map((event) => ({
								sequence: event.sequence,
								kind: event.kind,
								payload: event.payloadJson
							}))
						});
					})
				)
			),
			Match.when({ op: 'benchmark.trial' }, (fields) =>
				deps.withStore(
					Effect.gen(function*() {
						const store = yield* TaskStore.Tag;
						// trialId = `${jobId}:${profileId}:${trialNo}` — jobId contains no colon.
						const jobId = fields.trialId.slice(0, Math.max(0, fields.trialId.indexOf(':')));
						const trials = jobId.length === 0 ? [] : yield* store.listTrials(jobId);
						const trial = trials.find((candidate) => candidate.trialId === fields.trialId);
						if (trial === undefined) {
							return err(`unknown trial ${fields.trialId}`);
						}
						const trace = yield* store.listTrace(fields.trialId);
						const scores = yield* store.listScores(jobId);
						const score = scores.find((entry) => entry.trialId === trial.trialId);
						return ok({
							trialId: trial.trialId,
							status: trial.status,
							profileId: trial.profileId,
							model: `${trial.provider}/${trial.model}`,
							variant: trial.variant ?? null,
							outputChars: trial.outputBytes ?? null,
							durationMs: trial.durationMs ?? null,
							sessionId: trial.sessionId ?? null,
							errorReason: trial.errorReason ?? null,
							total: score?.total ?? null,
							trace: trace.map((event) => ({ sequence: event.sequence, kind: event.kind, payload: event.payloadJson }))
						});
					})
				)
			),
			Match.exhaustive
		);

	/** Total handler: domain failures become structured error results. */
	export const handle = (
		deps: BenchmarkToolDeps,
		rawInput: unknown
	): Effect.Effect<BenchmarkToolResult, never> =>
		Effect.gen(function*() {
			const decoded = Option.liftThrowable(decodeInput)(rawInput);
			if (Option.isNone(decoded)) {
				return err('invalid benchmark op input (schema mismatch)');
			}
			return yield* Effect.matchEffect(handleOp(deps, decoded.value), {
				onFailure: (error) => Effect.succeed(err(`${error.operation}: ${error.reason}`)),
				onSuccess: (result) => Effect.succeed(result)
			});
		});
}
