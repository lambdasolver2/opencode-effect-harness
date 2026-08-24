/**
 * Runner — executes blueprints against models on task suites.
 * Ties together Env (isolation), Llm (execution), and scoring.
 */
import { Context, Effect, Layer } from 'effect';

import { Run } from './Benchmark.ts';
import type { AcceptanceCriterion } from './Blueprint.ts';
import type { Blueprint } from './Blueprint.ts';
import { Env } from './Env.ts';
import { Llm, Prompt } from './Llm.ts';

interface ModelRef {
	readonly provider: string;
	readonly model: string;
}

interface TaskInput {
	readonly blueprint: Blueprint;
	readonly model: ModelRef;
	readonly taskId: string;
	readonly instruction: string;
}

export interface TaskError {
	readonly _tag: 'TaskError';
	readonly taskId: string;
	readonly model: string;
	readonly reason: string;
}

export interface ScoreResult {
	readonly score: number;
	readonly passed: boolean;
}

export namespace Runner {
	export interface Interface {
		runTask(options: TaskInput): Effect.Effect<Run, TaskError>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/compound/Runner'
	) {}

	// ------------------------------------------------------------------
	// Pure scoring — deterministic, no side effects
	// ------------------------------------------------------------------

	export const score = (
		criteria: ReadonlyArray<AcceptanceCriterion>,
		output: string
	): ScoreResult => {
		if (criteria.length === 0) return { score: 0, passed: false };

		const met = criteria.reduce((acc, c) => {
			if (c.check._tag === 'command' && output.includes(c.description)) return acc + 1;
			if (c.check._tag === 'agent-judge') return acc + 1;
			return acc;
		}, 0);

		const score = criteria.length > 0 ? met / criteria.length : 0;
		return { score, passed: score >= 0.5 };
	};

	const renderPrompt = (bp: Blueprint): string => {
		const parts = [bp.systemPrompt];
		if (bp.procedure.length > 0)
			parts.push('\nProcedure:', ...bp.procedure.map((s) => `- ${s}`));
		if (bp.pitfalls.length > 0)
			parts.push('\nKnown pitfalls:', ...bp.pitfalls.map((p) => `- ${p}`));
		return parts.join('\n');
	};

	// ------------------------------------------------------------------
	// Layer — constructs the service from Env + Llm tags
	// ------------------------------------------------------------------

	export const layer: Layer.Layer<Service, never, Env.Tag | Llm.Tag> =
		Layer.effect(
			Service,
			Effect.gen(function*() {
				const env = yield* Env.Tag;
				const llm = yield* Llm.Tag;

				const runTask = (input: TaskInput): Effect.Effect<Run, TaskError> =>
					Effect.gen(function*() {
						yield* env.create(input.taskId, `${input.model.provider}/${input.model.model}`, 1);

						const systemPrompt = renderPrompt(input.blueprint);
						const outcome = yield* llm.complete(
							new Prompt({ system: systemPrompt, user: input.instruction }),
							{ provider: input.model.provider, model: input.model.model }
						);

						const result = Runner.score(
							input.blueprint.acceptance ?? [],
							outcome.text
						);

						return new Run({
							blueprintId: input.blueprint.id,
							modelProvider: input.model.provider,
							modelName: input.model.model,
							taskId: input.taskId,
							score: result.score,
							passed: result.passed,
							durationMs: outcome.durationMs,
							tracePath: `.effect-harness/workspaces/${input.taskId}-${input.model.provider}-${input.model.model}`
						});
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.fail({
								_tag: 'TaskError' as const,
								taskId: input.taskId,
								model: `${input.model.provider}/${input.model.model}`,
								reason: String(cause)
							})
						)
					);

				return Service.of({ runTask });
			})
		);
}
