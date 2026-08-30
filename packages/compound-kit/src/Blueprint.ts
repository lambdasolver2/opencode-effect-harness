/**
 * Blueprint — atomic declarative prompt modules composed purely, plus the
 * append-only markdown persistence contract (spec A11/A24/A37).
 *
 * `composeBlueprints` dedupes stable (id, version) refs, preserves declared
 * order, and FAILS on declared provides/conflicts instead of concatenating.
 * Generated content is data only — never executed.
 */
import { Effect, Schema } from 'effect';

import { CommandSpec } from 'opencode-harness-shared';

export class FailureMode extends Schema.Class<FailureMode>('FailureMode')({
	symptom: Schema.String,
	cause: Schema.String,
	detection: Schema.String
}) {}

export class BlueprintModule extends Schema.Class<BlueprintModule>('BlueprintModule')({
	id: Schema.String,
	version: Schema.String,
	prompt: Schema.String,
	appliesWhen: Schema.Array(Schema.String),
	provides: Schema.Array(Schema.String),
	conflicts: Schema.Array(Schema.String),
	failureModes: Schema.Array(FailureMode),
	recovery: Schema.Array(Schema.String),
	evidence: Schema.Array(Schema.String)
}) {}

export class ModuleRef extends Schema.Class<ModuleRef>('ModuleRef')({
	id: Schema.String,
	version: Schema.String,
	required: Schema.Boolean
}) {}

export class CompositionError extends Schema.TaggedError<CompositionError>()(
	'CompositionError',
	{ reason: Schema.String }
) {}

export interface ComposedPrompt {
	readonly fragments: ReadonlyArray<{
		readonly id: string;
		readonly version: string;
		readonly prompt: string;
	}>;
	readonly joined: string;
}

const moduleKey = (m: { id: string; version: string }) => `${m.id}@${m.version}`;

export const composeBlueprints = (
	modules: ReadonlyArray<BlueprintModule>,
	refs: ReadonlyArray<ModuleRef>
): Effect.Effect<ComposedPrompt, CompositionError> =>
	Effect.gen(function*() {
		const byKey = new Map<string, BlueprintModule>(
			modules.map((m) => [moduleKey(m), m] as const)
		);

		const missing = refs.filter(
			(ref) => ref.required && !byKey.has(moduleKey(ref))
		);
		if (missing.length > 0) {
			return yield* Effect.fail(
				new CompositionError({
					reason: `missing required modules: ${missing.map((r) => moduleKey(r)).join(', ')}`
				})
			);
		}

		const resolved = refs
			.map((ref) => ({ ref, module: byKey.get(moduleKey(ref)) }))
			.flatMap((entry) => (entry.module !== undefined ? [entry] : []));

		const deduped = [
			...new Map(resolved.map((e) => [moduleKey(e.ref), e] as const)).values()
		];

		const conflict = deduped.reduce<string | undefined>((found, entry) => {
			if (found !== undefined) return found;
			return entry.module?.conflicts.find((c) =>
				deduped.some((other) => other.module?.provides.includes(c))
			);
		}, undefined);
		if (conflict !== undefined) {
			return yield* Effect.fail(
				new CompositionError({
					reason: `declared capability conflict on "${conflict}"`
				})
			);
		}

		const fragments = deduped.flatMap((entry) =>
			entry.module === undefined
				? []
				: [
					{
						id: entry.module.id,
						version: entry.module.version,
						prompt: entry.module.prompt
					}
				  ]
		);
		if (fragments.length === 0) {
			return yield* Effect.fail(
				new CompositionError({ reason: 'composition produced no modules' })
			);
		}
		return {
			fragments,
			joined: fragments
				.map((f) => `## ${f.id}@${f.version}\n${f.prompt}`)
				.join('\n\n')
		};
	});

// ---------------------------------------------------------------------------
// Execution + acceptance
// ---------------------------------------------------------------------------

export class ModelExecutionSpec extends Schema.Class<ModelExecutionSpec>(
	'ModelExecutionSpec'
)({
	workerAgent: Schema.String,
	modelProvider: Schema.optionalKey(Schema.String),
	modelModel: Schema.optionalKey(Schema.String),
	tools: Schema.Array(Schema.String),
	maxTurns: Schema.Number,
	timeoutMs: Schema.Number,
	budgetUsd: Schema.optionalKey(Schema.Number)
}) {}

export class AgentJudgeCheck extends Schema.Class<AgentJudgeCheck>('AgentJudgeCheck')({
	rubric: Schema.String,
	minScore: Schema.Number
}) {}

export class AcceptanceCriterion extends Schema.Class<AcceptanceCriterion>(
	'AcceptanceCriterion'
)({
	id: Schema.String,
	description: Schema.String,
	check: Schema.Union([
		Schema.TaggedStruct('command', {
			command: CommandSpec
		}),
		Schema.TaggedStruct('agent-judge', {
			judge: AgentJudgeCheck
		})
	])
}) {}

/** The persisted blueprint: ordered module refs + execution policy + acceptance. */
export class Blueprint extends Schema.Class<Blueprint>('Blueprint')({
	id: Schema.String,
	name: Schema.String,
	domain: Schema.String,
	systemPrompt: Schema.String,
	moduleRefs: Schema.Array(ModuleRef),
	execution: ModelExecutionSpec,
	acceptance: Schema.Array(AcceptanceCriterion),
	origins: Schema.Array(Schema.String),
	createdAt: Schema.Number
}) {}

// ---------------------------------------------------------------------------
// Prompt draft + pure patch fold (the variation surface for evolution)
// ---------------------------------------------------------------------------

export class PromptDraft extends Schema.Class<PromptDraft>('PromptDraft')({
	blueprintId: Schema.String,
	systemPrompt: Schema.String,
	procedure: Schema.Array(Schema.String),
	pitfalls: Schema.Array(Schema.String),
	execution: ModelExecutionSpec
}) {}

export const Change = Schema.Union([
	Schema.TaggedStruct('set-system-prompt', { value: Schema.NonEmptyString }),
	Schema.TaggedStruct('add-procedure-step', { value: Schema.NonEmptyString }),
	Schema.TaggedStruct('remove-procedure-step', { value: Schema.NonEmptyString }),
	Schema.TaggedStruct('add-pitfall', { value: Schema.NonEmptyString }),
	Schema.TaggedStruct('set-execution', {
		maxTurns: Schema.optionalKey(Schema.Number),
		timeoutMs: Schema.optionalKey(Schema.Number)
	})
]);

export class Patch extends Schema.Class<Patch>('BlueprintPatch')({
	blueprintId: Schema.String,
	description: Schema.String,
	changes: Schema.Array(Change)
}) {}

const applyOne = (draft: PromptDraft, patch: Patch): PromptDraft =>
	patch.changes.reduce((current, change) => {
		switch (change._tag) {
			case 'set-system-prompt':
				return new PromptDraft({ ...current, systemPrompt: change.value });
			case 'add-procedure-step':
				return new PromptDraft({
					...current,
					procedure: [...current.procedure, change.value]
				});
			case 'remove-procedure-step':
				return new PromptDraft({
					...current,
					procedure: current.procedure.filter((step) => step !== change.value)
				});
			case 'add-pitfall':
				return new PromptDraft({
					...current,
					pitfalls: [...current.pitfalls, change.value]
				});
			case 'set-execution':
				return new PromptDraft({
					...current,
					execution: new ModelExecutionSpec({
						...current.execution,
						...(change.maxTurns === undefined ? {} : { maxTurns: change.maxTurns }),
						...(change.timeoutMs === undefined ? {} : { timeoutMs: change.timeoutMs })
					})
				});
		}
	}, draft);

/** Pure fold — never mutates the input; skips foreign blueprint ids. */
export const applyPatches = (
	draft: PromptDraft,
	patches: ReadonlyArray<Patch>
): PromptDraft =>
	patches
		.filter((patch) => patch.blueprintId === draft.blueprintId)
		.reduce((current, patch) => applyOne(current, patch), draft);
