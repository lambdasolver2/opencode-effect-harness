import { Context, Effect, Layer } from 'effect';

import { Decision } from './Decision.ts';
import type * as Rule from './rule/Rule.ts';
import { RuleSet } from './rule/RuleSet.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
import type { Schema } from 'effect';

const beforeAgentStartRules = (
	rules: ReadonlyArray<Rule.Any>
): ReadonlyArray<Rule.BeforeAgentStart> =>
	rules.flatMap((rule) => (rule.phase === 'beforeAgentStart' ? [rule] : []));

const toolCallRules = (rules: ReadonlyArray<Rule.Any>): ReadonlyArray<Rule.ToolCall> =>
	rules.flatMap((rule) => (rule.phase === 'toolCall' ? [rule] : []));

const toolResultRules = (
	rules: ReadonlyArray<Rule.Any>
): ReadonlyArray<Rule.ToolResult> =>
	rules.flatMap((rule) => (rule.phase === 'toolResult' ? [rule] : []));

const runRules = <Input>(
	rules: ReadonlyArray<{
		readonly id: string;
		readonly evaluate: (input: Input) => Effect.Effect<ReadonlyArray<DecisionValue>>;
	}>,
	input: Input
): Effect.Effect<ReadonlyArray<DecisionValue>> =>
	Effect.forEach(rules, (rule) => rule.evaluate(input), { concurrency: 1 }).pipe(
		Effect.map((decisionsPerRule) => decisionsPerRule.flatMap((decisions) => [...decisions]))
	);

export namespace Engine {
	export interface Interface {
		readonly evaluateBeforeAgentStart: (
			input: Rule.BeforeAgentStartInput
		) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly evaluateToolCall: (
			input: Rule.ToolCallInput
		) => Effect.Effect<ReadonlyArray<DecisionValue>>;
		readonly evaluateToolResult: (
			input: Rule.ToolResultInput
		) => Effect.Effect<ReadonlyArray<DecisionValue>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/Engine'
	) {}

	/** Direct construction for hosts that compose services without layers. */
	export const make = (ruleSet: RuleSet.Interface): Interface => ({
		evaluateBeforeAgentStart: (input) =>
			Effect.flatMap(ruleSet.all, (rules) =>
				runRules(beforeAgentStartRules(rules), input)
			),
		evaluateToolCall: (input) =>
			Effect.flatMap(ruleSet.all, (rules) =>
				runRules(toolCallRules(rules), input)
			),
		evaluateToolResult: (input) =>
			Effect.flatMap(ruleSet.all, (rules) =>
				runRules(toolResultRules(rules), input)
			)
	});

	export const layer: Layer.Layer<Service, never, RuleSet.Service> =
		Layer.effect(
			Service,
			Effect.map(RuleSet.Service, (ruleSet) => Service.of(make(ruleSet)))
		);
}
