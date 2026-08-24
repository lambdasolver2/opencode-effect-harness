/**
 * Collector — companion-side HistoricalSessionSource over the full OpenCode
 * client (spec A17/A19). Runs OUTSIDE the plugin process; the server plugin
 * never imports this file.
 */
import { Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { OpenCode } from '@opencode-ai/client/effect';

import { SourceError, Summary, type Historical, type HistoricalPage } from 'opencode-compound-kit/Source.ts';

export interface CollectorOptions {
	readonly baseUrl: string;
	readonly directory?: string | undefined;
}

interface RawInfo {
	id?: unknown;
	title?: unknown;
	directory?: unknown;
	updatedAt?: unknown;
}

const toSummary = (info: RawInfo): Summary =>
	new Summary({
		sessionID: String(info.id ?? ''),
		...(typeof info.title === 'string' ? { title: info.title } : {}),
		...(typeof info.directory === 'string' ? { directory: info.directory } : {}),
		updatedAt:
			typeof info.updatedAt === 'string'
				? info.updatedAt
				: new Date().toISOString()
	});

export namespace Collector {
	export const make = (options: CollectorOptions): Historical.Service => ({
		list: () =>
			Effect.gen(function* () {
				const client = yield* OpenCode.make({ baseUrl: options.baseUrl }).pipe(Effect.provide(FetchHttpClient.layer));
				const summaries: Array<Summary> = [];
				let cursor: string | undefined;

				for (;;) {
					const page: {
						data: ReadonlyArray<RawInfo>;
						cursor?: { readonly next?: string | undefined };
					} = yield* client.session
						.list({
							...(options.directory !== undefined
								? { directory: options.directory as never }
								: {}),
							...(cursor !== undefined ? { cursor: cursor as never } : {})
						})
						.pipe(
							Effect.mapError(
								(): SourceError =>
									new SourceError({ reason: 'session list failed' })
							)
						);

					summaries.push(...page.data.map(toSummary));
					cursor = page.cursor?.next;
					if (cursor === undefined || summaries.length >= 1000) break;
				}
				const page: HistoricalPage = { summaries };
				return page;
			}),

		exportSanitized: (sessionID: string) =>
			Effect.gen(function* () {
				const client = yield* OpenCode.make({ baseUrl: options.baseUrl }).pipe(Effect.provide(FetchHttpClient.layer));
				const out = yield* client.session.export({
					sessionID: sessionID as never,
					sanitize: true
				});
				return { info: toSummary(out.info), messages: out.messages };
			}).pipe(
				Effect.mapError(
					(cause): SourceError =>
						new SourceError({ reason: `export failed: ${String(cause)}` })
				)
			)
	});
}
