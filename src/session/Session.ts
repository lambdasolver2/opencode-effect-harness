/**
 * Sessions — resolve a tool-hook sessionID to its absolute project directory
 * (spec A7: hook payloads carry no cwd). Results are cached per session for
 * the plugin generation; conservative reload semantics come from process
 * lifetime (cache dies with the scope).
 */
import { Context, Effect, Layer, Ref } from 'effect';

export class LocationError extends Schema.TaggedError<LocationError>()(
	'LocationError',
	{ sessionID: Schema.String, reason: Schema.String }
) {}

import { Schema } from 'effect';

import { projectKeyOf } from 'opencode-harness-shared/Refs.ts';

/** Host-branded ids cross this boundary only through these converters. */
export const asSessionId = <Brand>(value: string): Brand & string => value as Brand & string;
export const asAgentId = <Brand>(value: string): Brand & string => value as Brand & string;

interface SessionLocation {
	readonly directory: string;
	readonly projectKey: string;
}

export namespace Sessions {
	export interface Interface {
		resolve(sessionID: string): Effect.Effect<SessionLocation, LocationError>;
	}

	export class Tag extends Context.Service<Tag, Interface>()(
		'opencode-effect-harness/opencode/Sessions'
	) {}

	interface HostSessionApi {
		get(input: { readonly sessionID: unknown }): Effect.Effect<unknown>;
	}

	const readDirectory = (info: unknown): string | undefined => {
		if (typeof info !== 'object' || info === null) return undefined;
		const location = Reflect.get(info, 'location');
		if (typeof location !== 'object' || location === null) return undefined;
		const directory = Reflect.get(location, 'directory');
		return typeof directory === 'string' ? directory : undefined;
	};

	export const make = (
		sessionApi: HostSessionApi,
		sessionIdBrand: (value: string) => unknown
	): Interface => {
		const cache: Ref.Ref<Map<string, SessionLocation>> = Effect.runSync(
			Ref.make(new Map<string, SessionLocation>())
		);

		return {
			resolve: (sessionID) =>
				Effect.gen(function*() {
					const cached = Effect.runSync(Ref.get(cache)).get(sessionID);
					if (cached !== undefined) return cached;

					const info = yield* sessionApi
						.get({ sessionID: sessionIdBrand(sessionID) })
						.pipe(
							Effect.mapError(
								(): LocationError =>
									new LocationError({ sessionID, reason: 'session lookup failed' })
							)
						);
					const directory = readDirectory(info);
					if (directory === undefined) {
						return yield* Effect.fail(
							new LocationError({ sessionID, reason: 'session has no location.directory' })
						);
					}
					const resolved: SessionLocation = {
						directory,
						projectKey: projectKeyOf(directory)
					};
					yield* Ref.update(cache, (map) => new Map(map).set(sessionID, resolved));
					return resolved;
				})
		};
	};

	/** Layer factory — the host session domain is injected at the boundary. */
	export const layerFrom = (
		sessionApi: HostSessionApi,
		sessionIdBrand: (value: string) => unknown
	): Layer.Layer<Tag> => Layer.succeed(Tag, make(sessionApi, sessionIdBrand));
}
