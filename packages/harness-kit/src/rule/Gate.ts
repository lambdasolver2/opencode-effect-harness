/**
 * Gate rule — blocks prospective writes that introduce framework code until
 * enough distinct skills are loaded.
 *
 * Preserved semantics (upstream parity + normative corrections):
 *  - prospective projection: deletion-only changes leaving no framework code pass
 *  - pending in-flight reads count alongside confirmed loads
 *  - strict ONLY for configured agents; everyone else is advisory
 *  - a projection that cannot produce authoritative content is handled by the
 *    explicit `failClosed` policy — never by silently allowing the write
 */
import type { Schema } from 'effect';
import { Effect, Option } from 'effect';

import { EFFECT_CODE_RE } from '../Constants.ts';
import { Decision } from '../Decision.ts';
import { Intent } from '../Intent.ts';
import { Input } from '../Input.ts';
import type * as Rule from './Rule.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

export namespace Gate {
	export interface Options {
		readonly min: number;
		/** Strict mode applies only to these agents; all others are advisory. */
		readonly strictAgents: ReadonlyArray<string>;
		/** When projection is unavailable: true blocks, false allows explicitly. */
		readonly failClosed: boolean;
		readonly reason: (loaded: number) => Effect.Effect<string>;
		readonly loaded: (sessionId: string) => Effect.Effect<number>;
		readonly project: (
			cwd: string,
			intent: IntentValue
		) => Effect.Effect<Input.Value>;
	}

	const noDecisions: ReadonlyArray<DecisionValue> = [];

	const block = (reason: string): ReadonlyArray<DecisionValue> => [
		new Decision.BlockToolCall({ reason })
	];

	export const rule = (options: Options): Rule.ToolCall => ({
		id: 'gate',
		phase: 'toolCall',
		evaluate: (input) => {
			const strict =
				input.agent !== undefined && options.strictAgents.includes(input.agent);
			if (!strict) return Effect.succeed(noDecisions);

			return Effect.flatMap(
				options.project(input.cwd, input.writeIntent),
				(projection) => {
					if (Option.isNone(projection.content)) {
						if (!options.failClosed) return Effect.succeed(noDecisions);
						return Effect.succeed(
							block(
								`harness gate: cannot verify this edit safely (${projection.projectionError ?? 'projection unavailable'}). ` +
									'Open the file to confirm the result, then retry.'
							)
						);
					}
					if (!EFFECT_CODE_RE.test(projection.content.value)) {
						return Effect.succeed(noDecisions);
					}
					return Effect.flatMap(
						options.loaded(input.sessionId ?? ''),
						(loaded) =>
							loaded < options.min
								? Effect.map(options.reason(loaded), block)
								: Effect.succeed(noDecisions)
					);
				}
			);
		}
	});
}
