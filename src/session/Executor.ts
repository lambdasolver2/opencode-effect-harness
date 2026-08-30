/**
 * SessionExecutor — runs one benchmark generation through the OpenCode host
 * (spec 06 §5). This is the adapter boundary for host-branded APIs: the only
 * place where `Model.Ref`, `Location.Ref`, and branded session ids are built.
 *
 * Pipeline per generation:
 *   catalog validation (provider+model+EXACT variant, Option-based) →
 *   `Model.Ref.parse` in a TYPED error channel (invalid refs never become
 *   undefined) → session.create({agent, model, location}) decoded through a
 *   NonEmptyString id schema → origin registration (read-only child, system
 *   prompt injected by the context hook) → session.generate decoded through
 *   a NonEmptyString output schema (an "empty generation" is a decode
 *   failure, not an `if`) → {text, durationMs, sessionID}.
 *
 * Interruption is sent ONLY on the timeout/interrupt failure path — a
 * successful generation is never interrupted. Origin cleanup runs in
 * `ensuring`.
 */
import { Clock, Context, Duration, Effect, Exit, Layer, Match, Option, Schema } from 'effect';

import { ModelProfile } from 'opencode-compound-kit/Task.ts';

/** Executor failure operations — a Literal union, so status mapping via a
 *  total Record cannot miss a case. */
export type ExecutorOperation = Schema.Schema.Type<typeof ExecutorOperation>;
export const ExecutorOperation = Schema.Literals(['model', 'session', 'generate', 'timeout']);

export class ExecutorError extends Schema.TaggedError<ExecutorError>()(
	'ExecutorError',
	{ operation: ExecutorOperation, reason: Schema.String }
) {}

export interface GenerationRequest {
	readonly label: string;
	readonly system: string;
	readonly user: string;
	readonly profile: ModelProfile;
	readonly agentId: string;
	readonly workspaceDir: string;
	readonly timeoutMs: number;
}

export interface GenerationResult {
	readonly text: string;
	readonly durationMs: number;
	readonly sessionId: string;
	/** Deferred until the durable trial outcome is persisted. */
	readonly releaseOrigin: Effect.Effect<void>;
}

/** Shape of the host model entry this executor validates against. */
export interface HostModelInfo {
	readonly id: string;
	readonly providerID: string;
	readonly variants: ReadonlyArray<{ readonly id: string }>;
}

export interface HostDeps {
	/** Catalog lookup (list-based; the pinned API has no model.get operation). */
	readonly modelInfo: (
		provider: string,
		model: string
	) => Effect.Effect<Option.Option<HostModelInfo>, ExecutorError>;
	readonly createSession: (input: {
		readonly agent: unknown;
		readonly model: unknown;
		readonly location: { readonly directory: string };
		readonly title: string;
	}) => Effect.Effect<unknown, ExecutorError>;
	readonly generate: (input: {
		readonly sessionID: unknown;
		readonly system: string;
		readonly prompt: string;
	}) => Effect.Effect<unknown, ExecutorError>;
	readonly interrupt: (sessionID: unknown) => Effect.Effect<void, ExecutorError>;
	readonly registerOrigin: (sessionID: string, systemPrompt: string) => Effect.Effect<void>;
	readonly unregisterOrigin: (sessionID: string) => Effect.Effect<void>;
	readonly brandSessionId: (value: string) => unknown;
	readonly brandAgentId: (value: string) => unknown;
	/** Build a branded host Model.Ref. Invalid refs fail TYPED (never undefined). */
	readonly buildModelRef: (
		provider: string,
		model: string,
		variant?: string | undefined
	) => Effect.Effect<unknown, ExecutorError>;
}

/** Host session-create responses are parsed, not guessed: a missing/empty id
 *  is a typed failure at the decode boundary. */
class CreatedSession extends Schema.Class<CreatedSession>('CreatedSession')({
	id: Schema.NonEmptyString
}) {}

/** Host generation output: an EMPTY generation is a decode failure, so no
 *  `if (text.length === 0)` exists anywhere. */
class GeneratedOutput extends Schema.Class<GeneratedOutput>('GeneratedOutput')({
	text: Schema.NonEmptyString
}) {}

const decodeCreatedSession = Schema.decodeUnknownSync(CreatedSession);
const decodeGeneratedOutput = Schema.decodeUnknownSync(GeneratedOutput);

export namespace Executor {
	export interface Service {
		run(request: GenerationRequest): Effect.Effect<GenerationResult, ExecutorError>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/opencode/benchmark/SessionExecutor'
	) {}

	export const make = (deps: HostDeps): Service => ({
		run: (request) =>
			Effect.gen(function*() {
				// 1. Catalog validation BEFORE any session exists (fail cheap, fail clearly).
				const info = yield* Effect.flatMap(
					deps.modelInfo(request.profile.provider, request.profile.model),
					Option.match({
						onNone: () =>
							Effect.fail(
								new ExecutorError({
									operation: 'model',
									reason: `unknown model ${request.profile.provider}/${request.profile.model} in catalog`
								})
							),
						onSome: Effect.succeed
					})
				);
				yield* Option.match(Option.fromNullishOr(request.profile.variant), {
					onNone: () => Effect.void,
					onSome: (variant) =>
						info.variants.some((candidate) => candidate.id === variant)
							? Effect.void
							: Effect.fail(
									new ExecutorError({
										operation: 'model',
										reason: `unknown variant '${variant}' for ${request.profile.provider}/${request.profile.model}`
									})
								)
				});

				// 2. Branded Model.Ref — parse failures are TYPED, never undefined.
				const modelRef = yield* deps.buildModelRef(
					request.profile.provider,
					request.profile.model,
					request.profile.variant
				);

				// 3. Isolated, read-only benchmark child session (id decoded via schema).
				const created = yield* deps
					.createSession({
						agent: deps.brandAgentId(request.agentId),
						model: modelRef,
						location: { directory: request.workspaceDir },
						title: `benchmark: ${request.label}`
					})
					.pipe(
						Effect.flatMap((response: unknown) =>
							Effect.try({
								try: () => decodeCreatedSession(response),
								catch: (): ExecutorError =>
									new ExecutorError({
										operation: 'session',
										reason: 'host returned no usable session id'
									})
							})
						),
						Effect.mapError(
							(cause): ExecutorError =>
								cause instanceof ExecutorError
									? cause
									: new ExecutorError({ operation: 'session', reason: String(cause) })
						)
					);

				const failWith = (operation: ExecutorOperation, reason: string): ExecutorError =>
					new ExecutorError({ operation, reason });
				const releaseOrigin = deps.unregisterOrigin(created.id);

				// 4. Origin (read-only + system prompt) lives for the whole generation.
				return yield* Effect.gen(function*() {
					yield* deps.registerOrigin(created.id, request.system);
					const startedAt = yield* Clock.currentTimeMillis;
					const generated = yield* deps
					.generate({
						sessionID: deps.brandSessionId(created.id),
						system: request.system,
						prompt: request.user
					})
						.pipe(
							Effect.timeout(Duration.millis(request.timeoutMs)),
							Effect.catchTag('TimeoutError', () =>
								Effect.fail(failWith('timeout', `generation exceeded ${String(request.timeoutMs)}ms`))
							),
							Effect.flatMap((response: unknown) =>
								Effect.map(
									Effect.try({
										try: (): string => decodeGeneratedOutput(response).text,
										catch: () => failWith('generate', 'empty generation')
									}),
									(text): string => text
								)
							),
							Effect.mapError(
								(cause): ExecutorError =>
									cause instanceof ExecutorError
										? cause
										: failWith('generate', String(cause))
							)
						);
					const endedAt = yield* Clock.currentTimeMillis;
					const result: GenerationResult = {
						text: generated.trim(),
						durationMs: endedAt - startedAt,
						sessionId: created.id,
						releaseOrigin
					};
					return result;
				}).pipe(
					// Interrupt ONLY the failure path (timeout/generate errors) — a
					// successful generation is never interrupted.
					Effect.catchTag('ExecutorError', (error) =>
						error.operation === 'timeout'
							? Effect.as(
									Effect.asVoid(Effect.orElseSucceed(deps.interrupt(deps.brandSessionId(created.id)), () => undefined)),
									Effect.fail(error)
								).pipe(Effect.flatten)
										: Effect.fail(error)
					),
					Effect.onExit((exit) =>
						Exit.isFailure(exit) ? Effect.orElseSucceed(releaseOrigin, () => undefined) : Effect.void
					)
				);
			})
	});

	export const layerFrom = (impl: Service): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(impl));
}
