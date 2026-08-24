/**
 * OpenAi — direct-AI adapter implementing the LLM executor via the OpenAI API.
 */
import { Effect } from 'effect';

import { Error as LlmError, Outcome, Prompt } from './Llm.ts';

interface ModelRef {
	readonly provider: string;
	readonly model: string;
}

export interface Options {
	readonly apiKey: string;
	readonly baseUrl?: string;
}

export const make = (options: Options) => ({
	complete: (prompt: Prompt, _model: ModelRef) =>
		Effect.gen(function*() {
			const startedAt = Date.now();
			const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';

			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`${baseUrl}/chat/completions`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${options.apiKey}`
						},
						body: JSON.stringify({
							model: prompt.system,
							messages: [
								{ role: 'system', content: prompt.system },
								{ role: 'user', content: prompt.user }
							]
						})
					}),
				catch: () => new LlmError({ reason: 'fetch failed' })
			});

			if (!response.ok) {
				return yield* Effect.fail(
					new LlmError({ reason: `HTTP ${String(response.status)}` })
				);
			}

			const json = yield* Effect.tryPromise({
				try: () => response.json() as Promise<Record<string, unknown>>,
				catch: () => new LlmError({ reason: 'invalid JSON response' })
			});

			const choices = json.choices as
				| Array<{ message?: { content?: string } }>
				| undefined;
			const usage = json.usage as
				| { prompt_tokens?: number; completion_tokens?: number }
				| undefined;

			return new Outcome({
				text: choices?.[0]?.message?.content ?? '',
				durationMs: Date.now() - startedAt
			});
		})
});
