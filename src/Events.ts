/**
 * Events — typed selectors over the host event stream plus a single
 * supervised consumer that fans one subscription out to:
 *   - skill activation crediting / compaction resets (telemetry keeps running
 *     even when mode is off)
 *   - the live trace sink used by internal child sessions (spec A19)
 *   - auto-verification triggers for builder sessions with pending changes
 *
 * The stream is global; every selector filters by project scope at its call
 * sites. Event payloads are parsed defensively at this boundary only.
 */
import { Effect, Stream } from 'effect';

export interface HostEvent {
	readonly id?: unknown;
	readonly type: string;
	readonly properties?: Record<string, unknown> | undefined;
	/** Pinned protocol events carry their payload at top-level `data`. */
	readonly data?: unknown;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;

const deepSessionId = (event: HostEvent): string | undefined => {
	const props = event.properties as Record<string, unknown> | undefined;
	const candidates: Array<unknown> = [
		props?.sessionID,
		recordOf(props?.data)?.sessionID,
		recordOf(event.data)?.sessionID
	];
	return candidates.find((v): v is string => typeof v === 'string');
};

const deepSkillName = (event: HostEvent): string | undefined => {
	const props = event.properties as Record<string, unknown> | undefined;
	const name =
		recordOf(props?.data)?.name ?? recordOf(event.data)?.name ?? props?.name;
	return typeof name === 'string' ? name : undefined;
};

export interface SkillActivated {
	readonly sessionID: string;
	readonly name: string;
}

export interface ExecutionEnded {
	readonly sessionID: string;
	readonly outcome: 'succeeded' | 'failed' | 'interrupted';
	/** Host event id — durable idempotency key for auto-runs. */
	readonly eventId: string | undefined;
}

export interface Compacted {
	readonly sessionID: string;
}

export const selectSkillActivated = (
	event: HostEvent
): SkillActivated | undefined =>
	event.type === 'session.skill.activated'
		? (() => {
			const sessionID = deepSessionId(event);
			const name = deepSkillName(event);
			return sessionID !== undefined && name !== undefined
				? { sessionID, name }
				: undefined;
		  })()
		: undefined;

export const selectCompacted = (event: HostEvent): Compacted | undefined =>
	event.type === 'session.compacted'
		? (() => {
			const sessionID = deepSessionId(event);
			return sessionID !== undefined ? { sessionID } : undefined;
		  })()
		: undefined;

export const selectExecutionEnded = (event: HostEvent): ExecutionEnded | undefined => {
	if (
		event.type !== 'session.execution.succeeded' &&
		event.type !== 'session.execution.failed' &&
		event.type !== 'session.execution.interrupted'
	) {
		return undefined;
	}
	const sessionID = deepSessionId(event);
	if (sessionID === undefined) return undefined;
	const eventId = typeof event.id === 'string' ? event.id : undefined;
	const outcome =
		event.type === 'session.execution.succeeded'
			? ('succeeded' as const)
			: event.type === 'session.execution.failed'
				? ('failed' as const)
				: ('interrupted' as const);
	return { sessionID, outcome, eventId };
};

/**
 * Capture assistant text per session for internal child sessions (critic /
 * benchmark). Restricted plugin context cannot export transcripts; observing
 * the public stream while the child runs is the documented live-trace path.
 */
export namespace LiveTraceSink {
	export interface Interface {
		record(sessionID: string, textChunk: string): void;
		lastAssistantText(sessionID: string): string | undefined;
	}

	interface TextPartEvent {
		readonly type: string;
		readonly properties?: Record<string, unknown>;
	}

	const textFromPart = (part: unknown): string | undefined => {
		if (typeof part !== 'object' || part === null) return undefined;
		const record = part as Record<string, unknown>;
		const type = record.type;
		const text = record.text;
		return type === 'text' && typeof text === 'string' ? text : undefined;
	};

	export const make = (): Interface => {
		const buffers: Map<string, string> = new Map();
		const MAX_SESSIONS = 200;

		return {
			record: (sessionID, chunk) => {
				buffers.set(sessionID, (buffers.get(sessionID) ?? '') + chunk);
				if (buffers.size > MAX_SESSIONS) {
					const oldest = buffers.keys().next().value;
					if (oldest !== undefined) buffers.delete(oldest);
				}
			},
			lastAssistantText: (sessionID) => {
				const value = buffers.get(sessionID)?.trim();
				return value !== undefined && value.length > 0 ? value : undefined;
			}
		};
	};

	/** Feed the sink from any message-part shaped event (defensive parse). */
	export const feed = (sink: Interface, event: HostEvent): void => {
		if (!event.type.startsWith('message.part.updated')) return;
		const props = event.properties as Record<string, unknown> | undefined;
		const partContainer =
			props?.part ?? recordOf(props?.data)?.part ?? recordOf(event.data)?.part;
		const text = textFromPart(partContainer);
		const sessionID = deepSessionId(event as HostEvent);
		if (text !== undefined && sessionID !== undefined) sink.record(sessionID, text);
	};
}

/** One supervised consumer; per-event failures never kill the fiber. */
export const consumeAll = <E>(
	stream: Stream.Stream<HostEvent, E>,
	handlers: {
		onSkillActivated?: (input: SkillActivated) => Effect.Effect<void>;
		onCompacted?: (input: Compacted) => Effect.Effect<void>;
		onExecutionEnded?: (input: ExecutionEnded) => Effect.Effect<void>;
		onAnyEvent?: (event: HostEvent) => void;
	}
): Effect.Effect<void, never, Scope.Scope> =>
	Stream.runForEach(stream, (event) => {
		handlers.onAnyEvent?.(event);
		const activated = selectSkillActivated(event);
		if (activated !== undefined) {
			return handlers.onSkillActivated?.(activated) ?? Effect.void;
		}
		const compacted = selectCompacted(event);
		if (compacted !== undefined) {
			return handlers.onCompacted?.(compacted) ?? Effect.void;
		}
		const ended = selectExecutionEnded(event);
		if (ended !== undefined) {
			return handlers.onExecutionEnded?.(ended) ?? Effect.void;
		}
		return Effect.void;
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.sync(() => {
				console.error('[opencode-effect-harness] event consumer stopped:', String(cause));
			})
		)
	);

import type { Scope } from 'effect';
