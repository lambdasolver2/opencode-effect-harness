/**
 * ClientExecutor — HostDeps implementation backed by the OpenCode HTTP
 * client. Lets benchmark jobs run OUTSIDE the plugin process (companion CLI):
 * the client talks to the opencode2 server exactly like the plugin does —
 * `session.create({ agent, model, location })` → `session.generate` — so a
 * real authenticated Zen/Go model can be benchmarked headlessly.
 *
 * Differences vs the plugin-context executor (Session/executor.ts):
 *  - ids are plain strings (the client takes unbranded values over HTTP);
 *  - no origin registry in client mode (the plugin context hook is a
 *    plugin-process concern); read-only safety comes from the server-side
 *    `generate` operation, which runs no tools and writes no session history.
 */
import { Effect, Option, Schema } from 'effect';
import { Model } from '@opencode-ai/schema/model';
import { Provider } from '@opencode-ai/schema/provider';

import { ModelProfile } from 'opencode-compound-kit/Task.ts';

import {
	ExecutorError,
	type HostDeps,
	type HostModelInfo
} from './Executor.ts';

/** Host model entry decoded from the catalog list response. */
export interface ClientModelInfo {
	readonly id: string;
	readonly providerID: string;
	readonly variants: ReadonlyArray<{ readonly id: string }>;
}

/** The client operations this executor needs (transport supplied elsewhere). */
export interface ClientOps {
	readonly catalogModelList: () => Effect.Effect<
		{ readonly data: ReadonlyArray<ClientModelInfo> },
		unknown
	>;
	readonly createSession: (input: {
		readonly agent: string;
		readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string };
		readonly location: { readonly directory: string };
		readonly title: string;
	}) => Effect.Effect<unknown, ExecutorError>;
	readonly generate: (input: {
		readonly sessionID: string;
		readonly system: string;
		readonly prompt: string;
	}) => Effect.Effect<unknown, ExecutorError>;
	readonly interrupt: (sessionID: string) => Effect.Effect<void, ExecutorError>;
}

/** Host create-session input decoded from the (unknown) branded values. */
const CreateSessionInput = Schema.Struct({
	agent: Schema.NonEmptyString,
	model: Schema.Struct({
		providerID: Schema.String,
		id: Schema.String,
		variant: Schema.optionalKey(Schema.String)
	}),
	location: Schema.Struct({ directory: Schema.String }),
	title: Schema.String
});
const decodeCreateSessionInput = Schema.decodeUnknownSync(CreateSessionInput);

/** Host generate input: session ids arrive as unknown branded values. */
const GenerateInput = Schema.Struct({
	sessionID: Schema.NonEmptyString,
	system: Schema.String,
	prompt: Schema.String
});
const decodeGenerateInput = Schema.decodeUnknownSync(GenerateInput);

const InterruptInput = Schema.Struct({ sessionID: Schema.NonEmptyString });
const decodeInterruptInput = Schema.decodeUnknownSync(InterruptInput);

const CreatedSession = Schema.Struct({ id: Schema.NonEmptyString });
const GeneratedOutput = Schema.Struct({ text: Schema.NonEmptyString });
const decodeCreatedSession = Schema.decodeUnknownSync(CreatedSession);
const decodeGeneratedOutput = Schema.decodeUnknownSync(GeneratedOutput);

export namespace ClientExecutor {
	/** Build the plugin-neutral HostDeps from plain client operations. */
	export const make = (ops: ClientOps): HostDeps => ({
		modelInfo: (provider, model) =>
			Effect.map(
				Effect.mapError(ops.catalogModelList(), (cause): ExecutorError =>
					new ExecutorError({ operation: 'model', reason: String(cause) })),
				(page) =>
					Option.map(
						Option.fromNullishOr(
							page.data.find((entry) => entry.providerID === provider && entry.id === model)
						),
						(entry): HostModelInfo => ({
							id: entry.id,
							providerID: entry.providerID,
							variants: entry.variants
						})
					)
			),
		createSession: (input) =>
			Effect.flatMap(
				Effect.try({
					try: () => decodeCreateSessionInput(input),
					catch: (): ExecutorError =>
						new ExecutorError({ operation: 'session', reason: 'unusable create-session input' })
				}),
				(decoded) =>
					Effect.mapError(
						ops.createSession({
							agent: decoded.agent,
							model: {
								providerID: decoded.model.providerID,
								id: decoded.model.id,
								...(decoded.model.variant !== undefined
									? { variant: decoded.model.variant }
									: {})
							},
							location: decoded.location,
							title: decoded.title
						}),
						(cause): ExecutorError =>
							new ExecutorError({ operation: 'session', reason: String(cause) })
					)
			),
		generate: (input) =>
			Effect.flatMap(
				Effect.try({
					try: () => decodeGenerateInput(input),
					catch: (): ExecutorError =>
						new ExecutorError({ operation: 'generate', reason: 'unusable generate input' })
				}),
				(decoded) =>
					Effect.mapError(
						ops.generate({
							sessionID: decoded.sessionID,
							system: decoded.system,
							prompt: decoded.prompt
						}),
						(cause): ExecutorError =>
							new ExecutorError({ operation: 'generate', reason: String(cause) })
					)
			),
		interrupt: (sessionID) =>
			Effect.orElseSucceed(
				Effect.flatMap(
					Effect.try({
						try: () => decodeInterruptInput({ sessionID }),
						catch: (): ExecutorError =>
							new ExecutorError({ operation: 'generate', reason: 'unusable interrupt input' })
					}),
					(decoded) =>
						Effect.mapError(
							ops.interrupt(decoded.sessionID),
							(cause): ExecutorError =>
								new ExecutorError({ operation: 'generate', reason: String(cause) })
						)
				),
				() => undefined
			),
		registerOrigin: () => Effect.void,
		unregisterOrigin: () => Effect.void,
		brandSessionId: (value) => value,
		brandAgentId: (value) => value,
		buildModelRef: (provider, model, variant) =>
			// The catalog check already validated provider/model/variant. Use the
			// actual OpenCode brands before crossing the HTTP client boundary.
			Effect.succeed(
				Model.Ref.make({
					providerID: Provider.ID.make(provider),
					id: Model.ID.make(model),
					...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) })
				})
			)
	});
}

// Re-export so consumers of the client executor keep a single import site.
export { ExecutorError };
