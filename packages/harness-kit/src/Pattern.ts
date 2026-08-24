import type { Rule as AstGrepRuleDefinition } from '@ast-grep/napi';
import picomatch from 'picomatch';
import { Schema } from 'effect';

import { RuleDefinition } from './RuleDefinition.ts';

export namespace Pattern {
	export const Event = Schema.Literals(['before', 'after'] as const);

	export class RegexDetector extends Schema.TaggedClass<RegexDetector>()(
		'RegexDetector',
		{
			pattern: Schema.String,
			matchInComments: Schema.Boolean
		}
	) {}

	const AstGrepRuleDefinitionSchema = Schema.declare<AstGrepRuleDefinition>(
		(input): input is AstGrepRuleDefinition =>
			typeof input === 'object' && input !== null &&
			!Array.isArray(input),
		{ expected: 'ast-grep rule object' }
	);

	export class AstDetector extends Schema.TaggedClass<AstDetector>()(
		'AstDetector',
		{
			// An AST detector matches if ANY of these ast-grep patterns or rule
			// objects matches. YAML frontmatter may spell legacy `pattern` as a
			// single string or a list; the catalog normalizes both forms.
			patterns: Schema.Array(Schema.String),
			inside: Schema.optionalKey(Schema.String),
			rules: Schema.optionalKey(Schema.Array(AstGrepRuleDefinitionSchema)),
			constraints: Schema.optionalKey(
				Schema.Record(Schema.String, AstGrepRuleDefinitionSchema)
			)
		}
	) {}

	export const Detector = Schema.Union([RegexDetector, AstDetector]);

	export class MatchLocation extends Schema.Class<MatchLocation>(
		'PatternMatchLocation'
	)({
		start: Schema.Number,
		end: Schema.Number,
		line: Schema.Number,
		column: Schema.Number,
		snippet: Schema.String
	}) {}

	export class Value extends Schema.Class<Value>('PatternValue')({
		name: Schema.String,
		description: Schema.String,
		event: Event,
		toolRegex: Schema.String,
		level: RuleDefinition.Severity,
		glob: Schema.optionalKey(Schema.String),
		ignoreGlob: Schema.optionalKey(Schema.Array(Schema.String)),
		detector: Detector,
		guidance: Schema.String,
		suggestedSkills: Schema.optionalKey(Schema.Array(Schema.String)),
		sourcePath: Schema.String
	}) {}

	/** Real glob semantics (picomatch) — equality/suffix was insufficient. */
	export const globMatchesFilePath = (
		pattern: Value,
		filePath?: string
	): boolean => {
		if (pattern.glob === undefined) return true;
		if (filePath === undefined) return false;
		return picomatch(pattern.glob)(filePath);
	};

	export const matchesToolName = (pattern: Value, toolName: string): boolean =>
		new RegExp(pattern.toolRegex).test(toolName);
}
