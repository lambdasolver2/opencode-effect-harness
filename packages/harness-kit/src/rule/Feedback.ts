/**
 * Feedback rule — after a successful write/edit, run every catalogued detector
 * over the ACTUAL post-write projection (path + changed spans preserved) and
 * deliver matches as one advisory message. Never blocks.
 */
import type { Schema } from 'effect';
import { Effect, Option } from 'effect';

import { Intent } from '../Intent.ts';
import type * as Rule from '../rule/Rule.ts';
import { Decision } from '../Decision.ts';
import { Input } from '../Input.ts';
import { findPatternMatches } from '../Matcher.ts';
import { Pattern } from '../Pattern.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

const rank: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	warning: 3,
	info: 4
};

export namespace Feedback {
	export interface Options {
		readonly patterns: Effect.Effect<ReadonlyArray<Pattern.Value>>;
		/** Full actual projection — path and changed spans MUST be preserved. */
		readonly actual: (
			cwd: string,
			intent: IntentValue
		) => Effect.Effect<Input.Value>;
	}

	const noDecisions: ReadonlyArray<DecisionValue> = [];

	const uniqueByname = (
		hits: ReadonlyArray<Pattern.Value>
	): ReadonlyArray<Pattern.Value> =>
		hits.filter(
			(hit, index) =>
				hits.findIndex((other) => other.name === hit.name) === index
		);

	const message = (
		filePath: string,
		hits: ReadonlyArray<Pattern.Value>
	): DecisionValue => {
		const ordered = [...hits].sort(
			(a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9)
		);
		const sections = ordered.map((pattern) =>
			[
				`- ${pattern.name} [${pattern.level}]: ${pattern.description}`,
				pattern.guidance,
				pattern.suggestedSkills === undefined
					? ''
					: `Suggested skills: ${pattern.suggestedSkills.join(', ')}`
			]
				.filter((part) => part.length > 0)
				.join('\n')
		);
		return new Decision.InjectUserMessage({
			message: {
				content: [
					`harness review:\nfile: \`${filePath}\``,
					'Potential framework-pattern issues in this write. Revise if valid; if a false positive or intentional exception, say so briefly and continue.',
					'Matched patterns:',
					...sections
				].join('\n\n'),
				deliverAs: 'followUp'
			}
		});
	};

	export const rule = (options: Options): Rule.ToolResult => ({
		id: 'feedback',
		phase: 'toolResult',
		evaluate: (input) =>
			Effect.flatMap(options.actual(input.cwd, input.writeIntent), (projection) => {
				if (Option.isNone(projection.content)) return Effect.succeed(noDecisions);

				return Effect.map(options.patterns, (patterns) => {
					const hits = patterns.filter((pattern) =>
						findPatternMatches(
							input.toolName,
							projection,
							'after',
							pattern
						).length > 0
					);
					if (hits.length === 0) return noDecisions;
					const filePath = Option.getOrElse(
						projection.filePath,
						() => input.writeIntent.filePath ?? '(unknown)'
					);
					return [message(filePath, uniqueByname(hits))];
				});
			})
	});
}
