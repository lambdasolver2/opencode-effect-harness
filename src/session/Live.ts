/**
 * LiveSessionSource adapter — implements compound/source.ts Live port over
 * the OpenCode event stream.
 */
import { Context, Effect, Layer, Option, Ref, Stream } from 'effect'

import { SourceError, Summary } from 'opencode-compound-kit/Source.ts'
import type { SessionEvent } from 'opencode-compound-kit/Source.ts'

export interface HostEvent {
	readonly type: string
	readonly properties?: Record<string, unknown> | undefined
}

export namespace LiveSessions {
	export interface Service {
		explicit(sessionID: string): Effect.Effect<Summary, SourceError>
		follow(): Stream.Stream<SessionEvent>
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/LiveSessionSource'
	) {}

	const deepSessionId = (event: HostEvent): string | undefined => {
		const props = event.properties
		if (props === undefined) return undefined
		const direct = props.sessionID
		if (typeof direct === 'string') return direct
		const data = props.data
		if (typeof data === 'object' && data !== null) {
			const v = Reflect.get(data, 'sessionID')
			if (typeof v === 'string') return v
		}
		return undefined
	}

	interface MutableSession {
		readonly id: string
		title?: string | undefined
		events: Array<SessionEvent>
	}

	export const make = (
		hostStream: Stream.Stream<HostEvent, never>
	): Layer.Layer<Tag> =>
		Layer.effect(
			Tag,
			Effect.gen(function* () {
				const sessions = yield* Ref.make(new Map<string, MutableSession>())

				// Keep an in-memory index for explicit() lookups; run as scoped fiber.
				yield* Stream.runForEach(hostStream, (event) =>
					Effect.gen(function* () {
						const sid = deepSessionId(event)
						if (sid === undefined) return
						const title = typeof event.properties?.title === 'string' ? event.properties.title : undefined
						yield* Ref.update(sessions, (map) => {
							const existing = map.get(sid)
							const next = new Map(map)
							next.set(sid, {
								id: sid,
								...(title !== undefined
									? { title }
									: existing?.title !== undefined
										? { title: existing.title }
										: {}),
								events: existing?.events ?? []
							})
							return next
						})
					})
				).pipe(Effect.forkScoped, Effect.ignore)

				return Tag.of({
					explicit: (sessionID) =>
						Effect.map(Ref.get(sessions), (map) => {
							const s = map.get(sessionID)
							return new Summary({
								sessionID,
								...(s?.title !== undefined ? { title: s.title } : {}),
								updatedAt: new Date().toISOString()
							})
						}),
					follow: () =>
						hostStream.pipe(
							Stream.filter((event) => deepSessionId(event) !== undefined),
							Stream.map((event) => {
								const sessionID = deepSessionId(event) as string
								const type = event.type
								const kind: SessionEvent['kind'] =
									type.includes('execution') ? 'execution' : type.includes('compaction') ? 'compaction' : type.includes('skill') ? 'text' : 'text'
								const timestamp = Date.now()
								const payload = event.properties ?? {}
								return { sessionID, sequence: undefined, kind, timestamp, payload } as SessionEvent
							})
						)
				})
			})
		)
}
