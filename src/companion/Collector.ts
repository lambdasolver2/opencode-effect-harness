/**
 * Collector — companion-side HistoricalSessionSource over the full OpenCode
 * client. Auto-discovers the running OpenCode2 background service.
 * No hardcoded URLs or ports.
 */
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import * as NodeFsLayer from '@effect/platform-node/NodeFileSystem'
import { OpenCode } from '@opencode-ai/client/effect'
import { discover, headers } from '@opencode-ai/client/effect/service'

import type { Historical, HistoricalPage } from 'opencode-compound-kit/Source.ts'
import { SourceError, Summary } from 'opencode-compound-kit/Source.ts'

export interface CollectorOptions {
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

export const make = (options?: { readonly directory?: string | undefined } | undefined): Historical.Service => ({
	list: () =>
		Effect.gen(function* () {
			const endpoint = yield* discover()
			if (!endpoint) return { summaries: [] }

			const authHeaders = headers(endpoint)
			const client = yield* OpenCode.make({
				baseUrl: endpoint.url,
				...(authHeaders !== undefined ? { headers: authHeaders } : {})
			}).pipe(Effect.provide(FetchHttpClient.layer))

			const summaries: Array<Summary> = []
			let cursor: string | undefined
			let hasMore = true

			while (hasMore) {
				const page = yield* client.session.list({
					...(options !== undefined && options.directory !== undefined ? { directory: options.directory as never } : {}),
					...(cursor !== undefined ? { cursor: cursor as never } : {})
				}).pipe(
					Effect.mapError((): SourceError => new SourceError({ reason: 'list failed' }))
				)
				summaries.push(...page.data.map(toSummary))
				cursor = page.cursor?.next
				hasMore = cursor !== undefined && summaries.length < 1000
			}

			const result: HistoricalPage = { summaries }
			return result
		}),

	exportSanitized: (sessionID: string) =>
		Effect.gen(function* () {
			const endpoint = yield* discover()
			if (!endpoint) return undefined

			const authHeaders = headers(endpoint)
			const client = yield* OpenCode.make({
				baseUrl: endpoint.url,
				...(authHeaders !== undefined ? { headers: authHeaders } : {})
			}).pipe(Effect.provide(FetchHttpClient.layer))

			const out = yield* client.session.export({
				sessionID: sessionID as never,
				sanitize: true
			})
			return { info: toSummary(out.info), messages: out.messages }
		})
})
