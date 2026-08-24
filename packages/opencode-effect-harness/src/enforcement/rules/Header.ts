/**
 * Header rule — injects merged framework guidance before every agent start
 * while harness mode is enabled.
 */
import type { Schema } from 'effect';
import { Effect } from 'effect';

import { Decision } from '../Decision.ts';
import type * as Rule from '../Rule.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;

export namespace Header {
	export interface Options {
		header: Effect.Effect<string>;
		/** Mode gate — composed here so disabled mode yields no decisions. */
		enabled: Effect.Effect<boolean>;
	}

	const noDecisions: ReadonlyArray<DecisionValue> = [];

	export const rule = (options: Options): Rule.BeforeAgentStart => ({
		id: 'header',
		phase: 'beforeAgentStart',
		evaluate: () =>
			Effect.flatMap(options.enabled, (enabled) =>
				enabled
					? Effect.map(options.header, (content): ReadonlyArray<DecisionValue> => [
						new Decision.InjectSystemPrompt({ content })
					])
					: Effect.succeed(noDecisions)
			)
	});
}
