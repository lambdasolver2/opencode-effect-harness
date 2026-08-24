/**
 * Collector — companion-side HistoricalSessionSource over the full OpenCode
 * client (spec A17/A19). Runs OUTSIDE the plugin process.
 */
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { OpenCode } from '@opencode-ai/client/effect'

import type { Historical, HistoricalPage } from 'opencode-compound-kit/Source.ts'
import { SourceError, Summary } from 'opencode-compound-kit/Source.ts'

export interface CollectorOptions {
	readonly baseUrl: string
	readonly directory?: string | undefined
}

interface RawInfo {
	id?: unknown
	title?: unknown
	directory?: unknown
	updatedAt?: unknown
}

const toSummary = (info: RawInfo): Summary =>
	new Summary({
		sessionID: String(info.id ?? ''),
		...(typeof info.title === 'string' ? { title: info.title } : {}),
		...(typeof info.directory === 'string' ? { directory: info.directory } : {}),
		updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : new Date().toISOString()
	})

export const make = (options: CollectorOptions): Historical.Service => ({
	list: () =>
		Effect.gen(function* () {
			const client = yield* Effect.provide(
				OpenCode.make({ baseUrl: options.baseUrl }),
				FetchHttpClient.layer
			)
			const page = yield* client.session.list({
				...(options.directory !== undefined ? { directory: options.directory as never } : {})
			}).pipe(
				Effect.mapError((): SourceError => new SourceError({ reason: 'session list failed' }))
			)
			const summaries = page.data.map(toSummary)
			const result: HistoricalPage = { summaries }
			return result
		}),

		exportSanitized: (sessionID: string) =>
		Effect.gen(function* () {
			const client = yield* OpenCode.make({ baseUrl: options.baseUrl }).pipe(Effect.provide(FetchHttpClient.layer))
			const out = yield* client.session.export({
				sessionID: sessionID as never,
				sanitize: true
			}).pipe(
				Effect.mapError((): SourceError => new SourceError({ reason: 'export failed' }))
			)
			return { info: toSummary(out.info), messages: out.messages }
		})
})
