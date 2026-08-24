/**
 * Policy header — injects the merged guidance docs before every agent start
 * while the harness is enabled.
 */
import { Effect, Schema } from 'effect';

import { Decision } from 'opencode-harness-kit/Decision.ts';
import type { BeforeAgentStart, BeforeAgentStartInput } from 'opencode-harness-kit/harness/Rule.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;

export declare namespace Header {
	export interface Options {
		readonly header: Effect.Effect<string>;
		readonly enabled: Effect.Effect<boolean>;
	}

	export interface Rule extends BeforeAgentStart {}
}

export namespace Header {
	export const rule = (options: Header.Options): Header.Rule => ({
		id: 'header',
		phase: 'beforeAgentStart',
		evaluate: (_input: BeforeAgentStartInput) =>
			Effect.flatMap(options.enabled, (enabled) =>
				enabled
					? Effect.map(
						options.header,
						(content): ReadonlyArray<DecisionValue> => [
							new Decision.InjectSystemPrompt({ content })
						]
					)
					: Effect.succeed([] as ReadonlyArray<DecisionValue>)
			)
	});
}
