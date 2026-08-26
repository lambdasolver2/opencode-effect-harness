/**
 * Benchmark — scorecards over raw runs. Aggregation is total (every expected
 * model/task pair present exactly once), rejects duplicates, and labels n=1
 * so single-run results are never presented as statistically settled.
 */
import { Effect, Schema } from 'effect';

export class Run extends Schema.Class<Run>('BenchmarkRun')({
	blueprintId: Schema.String,
	modelProvider: Schema.String,
	modelName: Schema.String,
	taskId: Schema.String,
	score: Schema.Number,
	passed: Schema.Boolean,
	durationMs: Schema.Number,
	tokensIn: Schema.optionalKey(Schema.Number),
	tokensOut: Schema.optionalKey(Schema.Number),
	evaluatorVersion: Schema.String,
	tracePath: Schema.optionalKey(Schema.String)
}) {}

export class ModelScore extends Schema.Class<ModelScore>('ModelScore')({
	modelProvider: Schema.String,
	modelName: Schema.String,
	aggregateScore: Schema.Number,
	tasksPassed: Schema.Number,
	tasksTotal: Schema.Number
}) {}

export interface Scorecard {
	/** Always 1 for benchmark mode (spec A34). */
	readonly trialsPerModel: 1;
	readonly evaluatorVersion: string;
	readonly rows: ReadonlyArray<ModelScore>;
}

export class AggregateError extends Schema.TaggedError<AggregateError>()(
	'AggregateError',
	{ reason: Schema.String }
) {}

export interface AggregateInput {
	readonly evaluatorVersion: string;
	readonly blueprintId: string;
	readonly expectedTasks: ReadonlyArray<string>;
}

/**
 * Aggregate per-model scorecard from raw runs. Fails on duplicate
 * (model, task) keys, cross-blueprint or stale-evaluator runs, and missing
 * task results — an incomplete suite must not produce a ranked card.
 */
export const aggregate = (
	runs: ReadonlyArray<Run>,
	input: AggregateInput
): Effect.Effect<Scorecard, AggregateError> =>
	Effect.gen(function*() {
		const fold = runs.reduce<{ seen: Set<string>; error?: string }>(
			(acc, run) => {
				if (acc.error !== undefined) return acc;
				if (run.blueprintId !== input.blueprintId) {
					return { ...acc, error: `foreign blueprint ${run.blueprintId}` };
				}
				if (run.evaluatorVersion !== input.evaluatorVersion) {
					return {
						...acc,
						error: `stale evaluator ${run.evaluatorVersion} != ${input.evaluatorVersion}`
					};
				}
				if (!Number.isFinite(run.score) || run.score < 0) {
					return { ...acc, error: `invalid score ${String(run.score)}` };
				}
				const key = `${run.modelProvider}/${run.modelName}|${run.taskId}`;
				if (acc.seen.has(key)) {
					return { ...acc, error: `duplicate trial ${key}` };
				}
				const next = new Set(acc.seen);
				next.add(key);
				return { ...acc, seen: next };
			},
			{ seen: new Set<string>() }
		);
		if (fold.error !== undefined) {
			return yield* Effect.fail(new AggregateError({ reason: fold.error }));
		}

		const byModel = runs.reduce<Map<string, Array<Run>>>((map, run) => {
			const model = `${run.modelProvider}/${run.modelName}`;
			const bucket = map.get(model) ?? [];
			map.set(model, [...bucket, run]);
			return map;
		}, new Map<string, Array<Run>>());
		const incompleteModel = [...byModel.entries()].find(([, bucket]) =>
			input.expectedTasks.some(
				(task) => !bucket.some((run) => run.taskId === task)
			)
		);
		if (incompleteModel !== undefined) {
			return yield* Effect.fail(
				new AggregateError({ reason: `missing results for model ${incompleteModel[0]}` })
			);
		}

		const rows = [...byModel.entries()].map(([model, bucket]) => {
			const slash = model.indexOf('/');
			const provider = model.slice(0, slash);
			const name = model.slice(slash + 1);
			const total = bucket.reduce((sum, r) => sum + r.score, 0);
			return new ModelScore({
				modelProvider: provider,
				modelName: name,
				aggregateScore: bucket.length > 0 ? total / bucket.length : 0,
				tasksPassed: bucket.filter((r) => r.passed).length,
				tasksTotal: bucket.length
			});
		});

		const missing = input.expectedTasks.filter(
			(task) => ![...fold.seen.keys()].some((key) => key.endsWith(`|${task}`))
		);
		if (missing.length > 0) {
			return yield* Effect.fail(
				new AggregateError({ reason: `missing results for tasks ${missing.join(', ')}` })
			);
		}

		return { trialsPerModel: 1 as const, evaluatorVersion: input.evaluatorVersion, rows };
	});
