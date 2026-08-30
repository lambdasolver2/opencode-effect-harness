import { Schema } from 'effect';

/**
 * Declarative policy metadata (introspection/reporting surface). The actual
 * evaluate logic lives in executable rules (`enforcement/rule.ts`) — this
 * schema describes what a policy IS, never how it runs.
 */
export namespace RuleDefinition {
	export const Action = Schema.Literals([
		'blockToolCall',
		'injectUserMessage',
		'injectSystemPrompt',
		'appendCustomEntry'
	] as const);

	export const Severity = Schema.Literals([
		'critical',
		'high',
		'medium',
		'warning',
		'info'
	] as const);

	export class Definition extends Schema.Class<Definition>('RuleDefinition')({
		id: Schema.String,
		description: Schema.String,
		action: Action,
		severity: Severity,
		patternName: Schema.optionalKey(Schema.String),
		sourcePath: Schema.optionalKey(Schema.String)
	}) {}
}
