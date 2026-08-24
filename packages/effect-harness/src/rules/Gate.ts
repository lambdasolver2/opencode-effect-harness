/**
 * Gate — blocks prospective writes that introduce Effect code until
 * enough distinct `effect-*` skills are loaded.
 *
 * Preserved upstream semantics:
 *  - prospective projection: deletion-only changes leaving no Effect code pass
 *  - pending in-flight reads count alongside confirmed loads
 *  - advisory (never blocks) for non-strict agents / subagent workers
 */
import { Effect, Option, Schema } from 'effect';

import type { ToolCall, ToolCallInput } from 'opencode-harness-kit/harness/Rule.ts';
import { Decision } from 'opencode-harness-kit/Decision.ts';
import type { Intent } from 'opencode-harness-kit/Intent.ts';
import { EFFECT_CODE_RE } from '../Constants.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type Intent = Schema.Schema.Type<typeof Intent.Value>;

export namespace Gate {
	export interface Options {
		readonly min: number;
		/** Strict only for these agents; everyone else gets advisory mode. */
		readonly strict: boolean;
		reason: (loaded: number) => Effect.Effect<string>;
		loaded: (sessionId: string) => Effect.Effect<number>;
		project: (
			cwd: string,
			intent: Intent
		) => Effect.Effect<Option.Option<string>>;
	}

	export interface Rule extends ToolCall {}
}

export namespace Gate {
	export const rule = (options: Gate.Options): Gate.Rule => ({
		id: 'gate',
		phase: 'toolCall',
		evaluate: (input: ToolCallInput) =>
			options.strict === false
				? Effect.succeed([] as ReadonlyArray<DecisionValue>)
				: Effect.flatMap(
					options.project(input.cwd, input.writeIntent),
					(content) => {
						const text = Option.getOrElse(content, () => '');
						if (!EFFECT_CODE_RE.test(text)) {
							return Effect.succeed([] as ReadonlyArray<DecisionValue>);
						}
						return Effect.flatMap(
							options.loaded(input.sessionId ?? ''),
							(loaded) =>
								loaded < options.min
									? Effect.map(
										options.reason(loaded),
										(reason): ReadonlyArray<DecisionValue> => [
											new Decision.BlockToolCall({ reason })
										]
									)
									: Effect.succeed([] as ReadonlyArray<DecisionValue>)
						);
					}
				)
	});
}
