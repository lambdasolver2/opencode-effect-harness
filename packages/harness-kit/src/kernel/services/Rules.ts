import { Context, Effect, Layer } from 'effect';

import { Rule } from '../../Rule.ts';
import { Catalog } from './Catalog.ts';

type RuleValue = Rule.Definition;

const explicitRules = [
	new Rule.Definition({
		id: 'effect:require-loaded-skills-for-effect-writes',
		description:
			'Block prospective Effect writes until enough skills are loaded',
		action: 'blockToolCall',
		severity: 'high'
	}),
	new Rule.Definition({
		id: 'effect:send-pattern-feedback-after-write',
		description: 'Send advisory pattern feedback after successful writes',
		action: 'injectUserMessage',
		severity: 'warning'
	}),
	new Rule.Definition({
		id: 'effect:inject-effect-policy-header',
		description: 'Inject the Effect policy header before agent start',
		action: 'injectSystemPrompt',
		severity: 'info'
	})
] satisfies ReadonlyArray<RuleValue>;

export namespace Rules {
	export interface Interface {
		readonly getAll: Effect.Effect<
			ReadonlyArray<RuleValue>,
			never,
			Catalog.Service
		>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'ox-effect-harness/kernel/RuleCatalog'
	) {}

	export const layer = Layer.succeed(
		Service,
		Service.of({
			getAll: Catalog.Service.use((catalog) =>
				catalog.getRules.pipe(
					Effect.map((legacyRules) => [...legacyRules, ...explicitRules])
				)
			)
		})
	);
}
