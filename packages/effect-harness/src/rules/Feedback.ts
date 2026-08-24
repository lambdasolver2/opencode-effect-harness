/**
 * Pattern feedback — after a successful write/edit, project the actual
 * post-write content, run every catalogued detector, and deliver matches as a
 * single advisory message. Never blocks.
 */
import { Effect, Option, Schema } from 'effect';

import type { ToolResult, ToolResultInput } from 'opencode-harness-kit/harness/Rule.ts';
import { Input } from 'opencode-harness-kit/kernel/Input.ts';
import { findPatternMatches } from 'opencode-harness-kit/kernel/services/Matcher.ts';
import { Decision } from 'opencode-harness-kit/Decision.ts';
import { Pattern } from 'opencode-harness-kit/Pattern.ts';
import type { Intent } from 'opencode-harness-kit/Intent.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type Intent = Schema.Schema.Type<typeof Intent.Value>;

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
		readonly actual: (
			cwd: string,
			intent: Intent
		) => Effect.Effect<Option.Option<string>>;
	}

	export interface Rule extends ToolResult {}

	const projection = (intent: Intent, value: string): Input.Value =>
		new Input.Value({
			filePath: Option.fromUndefinedOr(intent.filePath),
			content: Option.some(value),
			changedSpans: Option.none(),
			command: Option.none(),
			pattern: Option.none(),
			query: Option.none(),
			url: Option.none(),
			prompt: Option.none()
		});

	const unique = (hits: ReadonlyArray<Pattern.Value>): ReadonlyArray<Pattern.Value> =>
		hits.filter(
			(hit, index) => hits.findIndex((other) => other.name === hit.name) === index
		);

	const message = (
		input: ToolResultInput,
		hits: ReadonlyArray<Pattern.Value>
	): DecisionValue => {
		const ordered = [...hits].sort(
			(a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9)
		);
		const file = input.writeIntent.filePath ?? '(unknown)';
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
					`harness review:\nfile: \`${file}\``,
					'Potential Effect-pattern issues in this write. Revise if valid; if a false positive or intentional exception, say so briefly and continue.',
					'Matched patterns:',
					...sections
				].join('\n\n'),
				deliverAs: 'followUp'
			}
		});
	};

	export const rule = (options: Options): Rule => ({
		id: 'feedback',
		phase: 'toolResult',
		evaluate: (input: ToolResultInput) =>
			Effect.flatMap(options.actual(input.cwd, input.writeIntent), (content) =>
				Option.isNone(content)
					? Effect.succeed([] as ReadonlyArray<DecisionValue>)
					: Effect.map(options.patterns, (patterns) => {
						const hits = patterns.filter((pattern) =>
							findPatternMatches(
								input.toolName,
								projection(input.writeIntent, content.value),
								'after',
								pattern
							).length > 0
						);
						return hits.length === 0 ? [] : [message(input, unique(hits))];
					})
			)
	});
}
