import { Option, Schema } from 'effect';

import { Edit } from './Edit.ts';

/**
 * MatcherInput — everything a detector may inspect for one event. When a write
 * projection cannot produce authoritative content, `content` is `None` and
 * `projectionError` carries the machine-readable reason so policy can decide
 * fail-open vs fail-closed explicitly instead of guessing.
 */
export namespace Input {
	export class Value extends Schema.Class<Value>('MatcherInput')({
		filePath: Schema.Option(Schema.String),
		content: Schema.Option(Schema.String),
		changedSpans: Schema.Option(Schema.Array(Edit.Span)),
		command: Schema.Option(Schema.String),
		pattern: Schema.Option(Schema.String),
		query: Schema.Option(Schema.String),
		url: Schema.Option(Schema.String),
		prompt: Schema.Option(Schema.String),
		projectionError: Schema.optionalKey(Schema.String)
	}) {}

	export const empty = (): Value =>
		new Value({
			filePath: Option.none(),
			content: Option.none(),
			changedSpans: Option.none(),
			command: Option.none(),
			pattern: Option.none(),
			query: Option.none(),
			url: Option.none(),
			prompt: Option.none()
		});
}
