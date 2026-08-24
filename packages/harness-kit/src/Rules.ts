import { Effect } from 'effect';

import { RuleDefinition } from './RuleDefinition.ts';

/**
 * Declarative metadata for the three built-in policies. Purely descriptive —
 * consumed by status/reporting surfaces; executable behavior lives in
 * `rules/Gate.ts`, `rules/Header.ts`, and `rules/Feedback.ts`.
 */
const definitions = [
	new RuleDefinition.Definition({
		id: 'effect:inject-policy-header',
		description: 'Inject the framework policy header before agent start',
		action: 'injectSystemPrompt',
		severity: 'info'
	}),
	new RuleDefinition.Definition({
		id: 'effect:require-loaded-skills-for-writes',
		description:
			'Block prospective framework-code writes until enough skills are loaded',
		action: 'blockToolCall',
		severity: 'high'
	}),
	new RuleDefinition.Definition({
		id: 'effect:send-pattern-feedback-after-write',
		description: 'Send advisory pattern feedback after successful writes',
		action: 'injectUserMessage',
		severity: 'warning'
	})
] as const;

export namespace Rules {
	export const all: ReadonlyArray<RuleDefinition.Definition> = [...definitions];

	export const describeAll = (): Effect.Effect<ReadonlyArray<RuleDefinition.Definition>> =>
		Effect.succeed(all);
}
