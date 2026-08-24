/**
 * Collector — companion-side HistoricalSessionSource over the full OpenCode
 * client. Auto-discovers the running OpenCode2 background service.
 * No hardcoded URLs or ports.
 */
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import NodePathLayer from '@effect/platform-node/NodePath'
import { OpenCode } from '@opencode-ai/client/effect'
import { discover, headers } from '@opencode-ai/client/effect/service'

import type { Historical, HistoricalPage } from 'opencode-compound-kit/Source.ts'
import { SourceError, Summary } from 'opencode-compound-kit/Source.ts'

const platform = Layer.mergeAll(NodeFsLayer.layer, NodePathLayer.layer)

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
			const endpoint = yield* Effect.orElseSucceed(discover().pipe(Effect.provide(platform)), () => undefined)
			if (!endpoint) return { summaries: [] }

			const authHeaders = headers(endpoint)
			const client = yield* OpenCode.make({
				baseUrl: endpoint.url,
				...(authHeaders !== undefined ? { headers: authHeaders } : {})
			}).pipe(Effect.provide(FetchHttpClient.layer))

			const paginate = (
				cursor: string | undefined,
				acc: ReadonlyArray<Summary>
			): Effect.Effect<ReadonlyArray<Summary>, SourceError> =>
				client.session.list({
					...(options?.directory !== undefined ? { directory: options.directory as never } : {}),
					...(cursor !== undefined ? { cursor: cursor as never } : {})
				}).pipe(
					Effect.flatMap((page) => {
						const all = [...acc, ...page.data.map(toSummary)]
						return page.cursor?.next !== undefined && all.length < 1000
							? paginate(page.cursor.next, all)
							: Effect.succeed(all)
					})
				)

			return paginate(undefined, []).pipe(
				Effect.map((summaries) => ({ summaries } as HistoricalPage))
			)
		}),

	exportSanitized: (sessionID: string) =>
		Effect.gen(function* () {
			const endpoint = yield* Effect.orElseSucceed(discover().pipe(Effect.provide(platform)), () => undefined)
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
