/**
 * Origins — registry of plugin-owned child sessions with their internal
 * origin. Registered sessions are excluded from automatic triggers and are
 * stripped of mutation-capable tools by the context hook AND re-checked in
 * execute.before (tool removal is not a security boundary).
 *
 * Also hosts the BlueprintExecutionRegistry: child session -> rendered prompt,
 * so the context hook can inject the dynamic system part that session.create
 * cannot carry (spec A8).
 */
import { Context, Effect, Layer, Ref } from 'effect';

import type { SessionOrigin } from '../shared/Refs.ts';

const MUTATION_TOOLS: ReadonlyArray<string> = [
	'write',
	'edit',
	'multiedit',
	'patch',
	'bash',
	'shell',
	'task'
];

export namespace Origins {
	export interface Interface {
		register(input: {
			readonly sessionID: string;
			readonly origin: Exclude<SessionOrigin, 'builder'>;
		}): Effect.Effect<void>;
		originOf(sessionID: string): Effect.Effect<SessionOrigin | undefined>;
		unregister(sessionID: string): Effect.Effect<void>;
		/** Blueprint system prompt registered for an internal execution session. */
		registerPrompt(input: {
			readonly sessionID: string;
			readonly systemPrompt: string;
		}): Effect.Effect<void>;
		promptFor(sessionID: string): Effect.Effect<string | undefined>;
		/** Strip mutation tools for internal sessions unless edits are allowed. */
		restrictTools(input: {
			readonly sessionID: string;
			readonly allowEdits: boolean;
			readonly tools: Record<string, unknown>;
		}): Effect.Effect<number>;
		isMutationTool(toolName: string): boolean;
	}

	export class Tag extends Context.Service<Tag, Interface>()(
		'opencode-effect-harness/opencode/Origins'
	) {}

	export const make = (): Interface => {
		const origins: Ref.Ref<Map<string, Exclude<SessionOrigin, 'builder'>>> =
			Effect.runSync(Ref.make(new Map<string, Exclude<SessionOrigin, 'builder'>>()));
		const prompts: Ref.Ref<Map<string, string>> =
			Effect.runSync(Ref.make(new Map<string, string>()));

		return {
			register: ({ sessionID, origin }) =>
				Ref.update(origins, (map) => new Map(map).set(sessionID, origin)),
			originOf: (sessionID) => Effect.map(Ref.get(origins), (m) => m.get(sessionID)),
			unregister: (sessionID) =>
				Effect.map(
					Effect.all([
						Ref.update(origins, (m) => {
							const next = new Map(m);
							next.delete(sessionID);
							return next;
						}),
						Ref.update(prompts, (m) => {
							const next = new Map(m);
							next.delete(sessionID);
							return next;
						})
					]),
					() => undefined
				),
			registerPrompt: ({ sessionID, systemPrompt }) =>
				Ref.update(prompts, (map) => new Map(map).set(sessionID, systemPrompt)),
			promptFor: (sessionID) => Effect.map(Ref.get(prompts), (m) => m.get(sessionID)),
			restrictTools: ({ sessionID, allowEdits, tools }) =>
				Effect.gen(function*() {
					const origin = yield* Effect.map(Ref.get(origins), (m) => m.get(sessionID));
					if (origin === undefined || allowEdits) return 0;
					const removed = MUTATION_TOOLS.reduce((count, key) => {
						if (!(key in tools)) return count;
						delete tools[key];
						return count + 1;
					}, 0);
					return removed;
				}),
			isMutationTool: (toolName) => MUTATION_TOOLS.includes(toolName)
		};
	};

	export const layer: Layer.Layer<Tag> = Layer.succeed(Tag, make());
}
