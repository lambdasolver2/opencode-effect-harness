/**
 * Llm — the single boundary between compound-core and any LLM backend.
 * Two adapters satisfy this: an OpenCode session executor and the direct-AI
 * adapter (`LlmOpenAi`). All prompt inputs are untrusted data; callers wrap
 * transcript/tool-output content in delimiters before calling.
 */
import { Context, Layer, Schema } from 'effect';

import type { ModelReference } from '../shared/Model.ts';

export class Prompt extends Schema.Class<Prompt>('Prompt')({
	system: Schema.String,
	user: Schema.String,
	maxTurns: Schema.optionalKey(Schema.Number)
}) {}

export class Outcome extends Schema.Class<Outcome>('Outcome')({
	text: Schema.String,
	tokensIn: Schema.optionalKey(Schema.Number),
	tokensOut: Schema.optionalKey(Schema.Number),
	durationMs: Schema.Number
}) {}

export class Error extends Schema.TaggedError<Error>()('LlmError', {
	reason: Schema.String,
	cause: Schema.optionalKey(Schema.String)
}) {}

export namespace Llm {
	export interface Service {
		readonly complete: (
			prompt: Prompt,
			model: ModelReference
		) => import('effect').Effect.Effect<Outcome, Error>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/Llm'
	) {}

	export const layer = (impl: Llm.Service): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(impl));
}
