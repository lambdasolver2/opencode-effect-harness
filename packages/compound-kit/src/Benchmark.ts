/**
 * Benchmark — model comparison on fixed task suites.
 *
 * Mode A semantics (spec A34/A46): exactly one run per (model, task) pair in
 * an isolated environment; scorecard labels n=1 so rankings are never
 * presented as statistically settled.
 */
import { Schema } from 'effect';

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
	/** Always 1 for the current benchmark mode. */
	readonly trialsPerModel: 1;
	readonly rows: ReadonlyArray<ModelScore>;
}

/**
 * Aggregate per-model scorecard from raw runs. Deterministic: mean of task
 * scores, count of passed tasks.
 */
export const aggregate = (runs: ReadonlyArray<Run>): Scorecard => {
	const byModel = new Map<string, Array<Run>>();
	runs.forEach((run) => {
		const key = `${run.modelProvider}/${run.modelName}`;
		const bucket = byModel.get(key) ?? [];
		bucket.push(run);
		byModel.set(key, bucket);
	});

	const rows = [...byModel.entries()].map(([key, bucket]) => {
		const [provider, modelName] = key.split('/', 2);
		const total = bucket.reduce((sum, r) => sum + r.score, 0);
		return new ModelScore({
			modelProvider: provider ?? '',
			modelName: modelName ?? '',
			aggregateScore: bucket.length > 0 ? total / bucket.length : 0,
			tasksPassed: bucket.filter((r) => r.passed).length,
			tasksTotal: bucket.length
		});
	});

	return { trialsPerModel: 1 as const, rows };
};
