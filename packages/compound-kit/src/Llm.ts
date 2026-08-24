/**
 * Llm — the single boundary between compound-core and any LLM backend.
 * Two adapters satisfy this: OpenCodeSessionExecutor (spawns a child session)
 * and DirectAiExecutor (@effect/ai providers for CI mode).
 *
 * All prompt inputs are treated as untrusted data (spec A44): callers wrap
 * transcript/tool-output content in delimiters before passing here.
 */
import { Context, Effect, Layer, Schema } from 'effect';

import type { ModelReference } from './Trace.ts';

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

export declare namespace Llm {
	export interface Service {
		readonly complete: (
			prompt: Prompt,
			model: ModelReference
		) => Effect.Effect<Outcome, Error>;
	}
}

export namespace Llm {
	export class Tag extends Context.Service<Tag, Llm.Service>()(
		'ox-effect-harness/compound/Llm'
	) {}

	export const layer = (impl: Llm.Service): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(impl));
}
