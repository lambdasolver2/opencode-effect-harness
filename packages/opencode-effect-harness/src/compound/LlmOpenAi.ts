/**
 * LlmOpenAi — ADAPTER: direct OpenAI chat-completions executor implementing
 * the compound `Llm` port for CI/standalone runs.
 *
 * Boundary notes (deliberate, documented):
 *  - global fetch is isolated to this adapter file; swapping in the Effect
 *    HTTP client is a one-file change and must not leak into core
 *  - the API key MUST be produced by `Config.redacted` upstream and is never
 *    logged by this module
 *  - responses are Schema-decoded; malformed payloads are typed failures
 *  - the requested ModelReference is honored (never prompt.system!)
 */
import { Context, Effect, Layer, Schema } from 'effect';

import { Error as LlmError, Outcome, Prompt } from './Llm.ts';
import { Llm } from './Llm.ts';
import type { ModelReference } from '../shared/Model.ts';

export interface Options {
	/** Value obtained from `Config.redacted(...)` — never logged. */
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly timeoutMs?: number | undefined;
}

const ResponseSchema = Schema.Struct({
	choices: Schema.Array(
		Schema.Struct({
			message: Schema.Struct({
				content: Schema.optionalKey(Schema.String)
			})
		})
	),
	usage: Schema.optionalKey(
		Schema.Struct({
			prompt_tokens: Schema.optionalKey(Schema.Number),
			completion_tokens: Schema.optionalKey(Schema.Number)
		})
	)
});

export const make = (options: Options): Llm.Service => ({
	complete: (prompt: Prompt, model: ModelReference) =>
		Effect.gen(function*() {
			const startedAt = Date.now();
			const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
			const timeoutMs = options.timeoutMs ?? 60_000;

			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`${baseUrl}/chat/completions`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${options.apiKey}`
						},
						body: JSON.stringify({
							model: model.model,
							messages: [
								{ role: 'system', content: prompt.system },
								{ role: 'user', content: prompt.user }
							]
						}),
						signal: AbortSignal.timeout(timeoutMs)
					}),
				catch: () => new LlmError({ reason: 'fetch failed or timed out' })
			});

			if (!response.ok) {
				return yield* Effect.fail(
					new LlmError({ reason: `HTTP ${String(response.status)}` })
				);
			}

			const json = yield* Effect.tryPromise({
				try: () => response.json() as Promise<unknown>,
				catch: () => new LlmError({ reason: 'invalid JSON response' })
			});

			const decoded = yield* Schema.decodeUnknownEffect(ResponseSchema)(json).pipe(
				Effect.mapError((issue) => new LlmError({ reason: `schema mismatch: ${String(issue)}` }))
			);

			const text = decoded.choices[0]?.message.content ?? '';
			if (text.length === 0) {
				return yield* Effect.fail(new LlmError({ reason: 'empty completion' }));
			}

			return new Outcome({
				text,
				tokensIn: decoded.usage?.prompt_tokens,
				tokensOut: decoded.usage?.completion_tokens,
				durationMs: Date.now() - startedAt
			} as ConstructorParameters<typeof Outcome>[0]);
		})
});

export const layer = (options: Options): Layer.Layer<Llm.Tag> =>
	Layer.succeed(Llm.Tag, Llm.Tag.of(make(options)));
