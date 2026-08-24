/**
 * Collector - companion-side HistoricalSessionSource over the full OpenCode
 * client. Auto-discovers the running OpenCode2 background service.
 */
import { Effect, Layer } from 'effect'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { FetchHttpClient } from 'effect/unstable/http'
import { OpenCode } from '@opencode-ai/client/effect'
import { discover, headers } from '@opencode-ai/client/effect/service'

import type { Historical } from 'opencode-compound-kit/Source.ts'
import { SourceError, Summary } from 'opencode-compound-kit/Source.ts'

const platformLayer = Layer.mergeAll(NodeFileSystem.layer)

const toSummary = (info: { id?: unknown; title?: unknown; directory?: unknown; updatedAt?: unknown }): Summary =>
	new Summary({
		sessionID: String(info.id ?? ''),
		...(typeof info.title === 'string' ? { title: info.title } : {}),
		updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : new Date().toISOString()
	})

export const make = (options: { directory?: string } = {}): Historical.Service => ({
  list: () =>
    Effect.gen(function* () {
      const endpoint = yield* Effect.provide(discover(), platformLayer).pipe(Effect.orElseSucceed(() => undefined))
      if (!endpoint) return { summaries: [] as Summary[] }

      const authHeaders = (headers as any)(endpoint)
      const client = yield* OpenCode.make({
        baseUrl: endpoint.url,
        ...(authHeaders !== undefined ? { headers: authHeaders } : {})
      }).pipe(Effect.provide(FetchHttpClient.layer))

      const paginate = (
        cursor: string | undefined,
        acc: ReadonlyArray<Summary>
      ): Effect.Effect<ReadonlyArray<Summary>, SourceError> =>
        client.session.list({
          ...(options.directory !== undefined ? { directory: options.directory as never } : {}),
          ...(cursor !== undefined ? { cursor: cursor as never } : {})
        }).pipe(
          Effect.mapError((): SourceError => new SourceError({ reason: 'list failed' })),
          Effect.flatMap((page) => {
            const all = [...acc, ...page.data.map(toSummary)]
            const next = page.cursor?.next ?? undefined
            if (next !== undefined && all.length < 1000) {
              return paginate(next ?? undefined, all)
            }
            return Effect.succeed(all)
          })
        )

      const summaries = yield* paginate(undefined, [])
      return { summaries }
    }),

  exportSanitized: (sessionID: string) =>
    Effect.gen(function* () {
      const endpoint = yield* Effect.provide(discover(), platformLayer).pipe(Effect.orElseSucceed(() => undefined))
      if (!endpoint) return { info: new Summary({ sessionID, updatedAt: '' }), messages: [] }

      const authHeaders = (headers as any)(endpoint)
      const client = yield* OpenCode.make({
        baseUrl: endpoint.url,
        ...(authHeaders !== undefined ? { headers: authHeaders } : {})
      }).pipe(Effect.provide(FetchHttpClient.layer))

      const out = yield* client.session.export({
        sessionID: sessionID as never,
        sanitize: true
      }).pipe(
        Effect.mapError((e): SourceError => new SourceError({ reason: String(e) }))
      )
      return { info: toSummary(out.info), messages: out.messages }
    })
})
