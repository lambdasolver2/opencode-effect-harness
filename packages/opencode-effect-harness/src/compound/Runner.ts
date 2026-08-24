/**
 * Runner — executes blueprints against models on task suites.
 *
 * Fixes over the audited skeleton:
 *  - the isolated workspace path is USED: acceptance commands run with it as cwd
 *  - workspace cleanup happens via acquireRelease even on failure
 *  - command checks are EXECUTED through the shared Exec port (no substring scoring)
 *  - agent-judge criteria go through the Judge port with an explicit min score
 *  - duplicate (blueprint, model, task, trial) keys are rejected
 */
import { Context, Effect, Layer, Ref, Schema } from 'effect';

import { CommandSpec, CommandResult, Exec } from '../shared/Command.ts';
import type { InvalidInput } from '../shared/Errors.ts';
import type { AcceptanceCriterion, Blueprint } from './Blueprint.ts';
import { Env } from './Env.ts';
import { Llm, Prompt } from './Llm.ts';
import { Run } from './Benchmark.ts';
import type { ModelReference } from '../shared/Model.ts';

export class TaskError extends Schema.TaggedError<TaskError>()('TaskError', {
	taskId: Schema.String,
	model: Schema.String,
	reason: Schema.String
}) {}

export interface JudgeInterface {
	score(input: {
		readonly rubric: string;
		readonly output: string;
	}): Effect.Effect<number>;
}

export class Judge extends Context.Service<Judge, JudgeInterface>()(
	'opencode-effect-harness/compound/Judge'
) {}


const modelLabel = (model: ModelReference): string =>
	`${model.provider}/${model.model}`;

export namespace Runner {
	export interface RunTaskInput {
		readonly blueprint: Blueprint;
		readonly model: ModelReference;
		readonly taskId: string;
		readonly instruction: string;
		/** Fixed to 1 in benchmark mode; recorded so multi-trial modes can extend. */
		readonly trial: number;
		readonly evaluatorVersion: string;
	}

	export interface Service {
		runTask(input: RunTaskInput): Effect.Effect<Run, TaskError>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/Runner'
	) {}

	const trialKey = (input: RunTaskInput): string =>
		`${input.blueprint.id}|${modelLabel(input.model)}|${input.taskId}|${String(input.trial)}`;

	const failWith = (input: RunTaskInput, reason: string): TaskError =>
		new TaskError({ taskId: input.taskId, model: modelLabel(input.model), reason });

	const asCommandCheck = (
		check: AcceptanceCriterion['check']
	): {
		readonly executable: string;
		readonly args: ReadonlyArray<string>;
		readonly timeoutMs: number;
		readonly maxOutputBytes: number;
	} | undefined =>
		check._tag === 'command' ? check.command : undefined;

	const asJudgeCheck = (
		check: AcceptanceCriterion['check']
	): { readonly rubric: string; readonly minScore: number } | undefined =>
		check._tag === 'agent-judge' ? check.judge : undefined;

	const evaluateCriterion = (
		exec: Exec.Interface,
		judge: JudgeInterface,
		criterion: AcceptanceCriterion,
		workspace: string,
		output: string
	): Effect.Effect<boolean> =>
	{
		const command = asCommandCheck(criterion.check);
		if (command !== undefined) {
			return exec
				.run(
					new CommandSpec({
						executable: command.executable,
						args: [...command.args],
						timeoutMs: command.timeoutMs,
						maxOutputBytes: command.maxOutputBytes,
						cwd: workspace
					})
				)
				.pipe(
					Effect.map(
						(result: CommandResult) =>
							result.exitCode === 0 && !result.timedOut
					),
					Effect.catchTag('ExecError', () => Effect.succeed(false))
				);
		}
		const judgeCheck = asJudgeCheck(criterion.check);
		if (judgeCheck === undefined) {
			return Effect.succeed(false);
		}
		return Effect.map(
			judge.score({ rubric: judgeCheck.rubric, output: output.slice(0, 20_000) }),
			(score) => score >= judgeCheck.minScore
		);
	}

	const runInWorkspace = (
		deps: {
			readonly env: Env.Service;
			readonly llm: Llm.Service;
			readonly exec: Exec.Interface;
			readonly judge: JudgeInterface;
		},
		input: RunTaskInput,
		workspace: string
	): Effect.Effect<Run, TaskError> =>
		Effect.scoped(
		Effect.acquireRelease(Effect.succeed(workspace), (dir) =>
			deps.env.destroy(dir).pipe(Effect.asVoid)
		).pipe(
			Effect.flatMap((ws) =>
				Effect.gen(function*() {
					const outcome = yield* deps.llm
						.complete(
							new Prompt({
								system: input.blueprint.systemPrompt,
								user: input.instruction,
								maxTurns: input.blueprint.execution.maxTurns
							}),
							input.model
						)
						.pipe(
							Effect.catchTag('LlmError', (e) =>
								Effect.fail(failWith(input, e.reason))
							)
						);

					const scored = yield* Effect.forEach(
						input.blueprint.acceptance,
						(criterion) =>
							evaluateCriterion(deps.exec, deps.judge, criterion, ws, outcome.text),
						{ concurrency: 2 }
					);
					const passedCount = scored.filter(Boolean).length;
					const total = scored.length;

					return new Run({
						blueprintId: input.blueprint.id,
						modelProvider: input.model.provider,
						modelName: input.model.model,
						taskId: input.taskId,
						evaluatorVersion: input.evaluatorVersion,
						score: total === 0 ? 0 : passedCount / total,
						passed: total > 0 && passedCount === total,
						durationMs: outcome.durationMs,
						...(outcome.tokensIn !== undefined ? { tokensIn: outcome.tokensIn } : {}),
						...(outcome.tokensOut !== undefined ? { tokensOut: outcome.tokensOut } : {})
					});
				})
			)
		));

	/** Direct construction; `keys` guards duplicate concurrent trials. */
	export const make = (deps: {
		readonly env: Env.Service;
		readonly llm: Llm.Service;
		readonly exec: Exec.Interface;
		readonly judge: JudgeInterface;
	}): Effect.Effect<Service> =>
		Effect.gen(function*() {
			const keys: Ref.Ref<Set<string>> = yield* Ref.make(new Set<string>());

			return {
				runTask: (input) =>
					Effect.gen(function*() {
						const key = trialKey(input);
						const acquired = yield* Ref.modify(keys, (set): readonly [{ ok: boolean }, Set<string>] => {
							if (set.has(key)) return [{ ok: false as const }, set] as const;
							return [{ ok: true as const }, new Set(set).add(key)] as const;
						});
						if (!acquired.ok) {
							return yield* Effect.fail(failWith(input, `duplicate trial key: ${key}`));
						}

						const workspace = yield* deps.env
							.create({
								taskId: input.taskId,
								modelLabel: `${input.model.provider}-${input.model.model}`,
								trial: input.trial
							})
							.pipe(
								Effect.mapError((e: InvalidInput) => failWith(input, e.reason))
							);

						return yield* runInWorkspace(deps, input, workspace).pipe(
							Effect.ensuring(
								Ref.modify(keys, (set) => {
									const next = new Set(set);
									next.delete(key);
									return [undefined, next] as const;
								}).pipe(Effect.asVoid)
							)
						);
					})
			};
		});

	export const layer = (deps: {
		readonly exec: Exec.Interface;
		readonly judge: JudgeInterface;
	}) =>
		Layer.effect(
			Tag,
			Effect.flatMap(Env.Tag, (env) =>
				Effect.flatMap(Llm.Tag, (llm) =>
					Effect.map(make({ ...deps, env, llm }), (service) => Tag.of(service)))),
		);
}
