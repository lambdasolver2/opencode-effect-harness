/**
 * Blueprint — a testable markdown module: distilled prompt + solution traces
 * + scores + evolution log. Structured schemas are the machine-readable
 * projection of the append-only markdown file.
 *
 * `applyPatches` is a pure fold (effect-autoagent heritage): it never mutates
 * its input and ignores patches targeting other blueprints.
 */
import { Schema } from 'effect';

export class AcceptanceCriterion extends Schema.Class<AcceptanceCriterion>(
	'AcceptanceCriterion'
)({
	id: Schema.String,
	description: Schema.String,
	check: Schema.Union([
		Schema.TaggedStruct('command', {
			executable: Schema.String,
			args: Schema.Array(Schema.String),
			successExitCode: Schema.Number
		}),
		Schema.TaggedStruct('agent-judge', {
			rubric: Schema.String,
			scoreMin: Schema.Number,
			scoreMax: Schema.Number
		})
	])
}) {}

export class ModuleRef extends Schema.Class<ModuleRef>('BlueprintModuleRef')({
	id: Schema.String,
	version: Schema.String,
	required: Schema.Boolean
}) {}

export class ExecutionSpec extends Schema.Class<ExecutionSpec>('ExecutionSpec')({
	workerAgent: Schema.String,
	tools: Schema.Array(Schema.String),
	maxTurns: Schema.Number,
	timeoutMs: Schema.Number
}) {}

export interface Blueprint {
	readonly id: string;
	readonly name: string;
	readonly version: number;
	readonly domain: string;
	readonly systemPrompt: string;
	readonly procedure: ReadonlyArray<string>;
	readonly pitfalls: ReadonlyArray<string>;
	readonly modules: ReadonlyArray<ModuleRef>;
	readonly execution: ExecutionSpec;
	readonly acceptance: ReadonlyArray<AcceptanceCriterion>;
	readonly origins: ReadonlyArray<string>;
	readonly createdAt: number;
}

export const Change = Schema.Union([
	Schema.TaggedStruct('set-system-prompt', { value: Schema.String }),
	Schema.TaggedStruct('add-procedure-step', { value: Schema.String }),
	Schema.TaggedStruct('add-pitfall', { value: Schema.String }),
	Schema.TaggedStruct('remove-procedure-step', { value: Schema.String }),
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

/** Pure fold — never mutates the input; skips foreign blueprint ids. */
export const applyPatches = (
	blueprint: Blueprint,
	patches: ReadonlyArray<Patch>
): Blueprint =>
	patches
		.filter((patch) => patch.blueprintId === blueprint.id)
		.reduce((current, patch) => applyOne(current, patch), blueprint);

const applyOne = (blueprint: Blueprint, patch: Patch): Blueprint => {
	let next = blueprint;
	for (const change of patch.changes) {
		switch (change._tag) {
			case 'set-system-prompt':
				next = { ...next, systemPrompt: change.value };
				break;
			case 'add-procedure-step':
				next = { ...next, procedure: [...next.procedure, change.value] };
				break;
			case 'remove-procedure-step':
				next = {
					...next,
					procedure: next.procedure.filter((step) => step !== change.value)
				};
				break;
			case 'add-pitfall':
				next = { ...next, pitfalls: [...next.pitfalls, change.value] };
				break;
			case 'set-execution':
				next = {
					...next,
					execution: new ExecutionSpec({
						...next.execution,
						...(change.maxTurns === undefined
							? {}
							: { maxTurns: change.maxTurns }),
						...(change.timeoutMs === undefined
							? {}
							: { timeoutMs: change.timeoutMs })
					})
				};
				break;
		}
	}
	return next;
};

