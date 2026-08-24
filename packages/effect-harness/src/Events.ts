/**
 * Events — typed selectors over the OpenCode event stream. Only the adapter
 * layer touches host event shapes; the rest of the plugin consumes these.
 */
import { Stream } from 'effect';

export type SkillActivated = {
	readonly type: 'session.skill.activated';
	readonly data: { readonly id: string; readonly name: string; readonly sessionID: string };
};

export type Compacted = {
	readonly type: 'session.compacted';
	readonly data: { readonly sessionID: string };
};

export type ExecutionEnded =
	| { readonly type: 'session.execution.succeeded'; readonly data: { readonly sessionID: string } }
	| { readonly type: 'session.execution.failed'; readonly data: { readonly sessionID: string; readonly error: unknown } }
	| { readonly type: 'session.execution.interrupted'; readonly data: { readonly sessionID: string; readonly reason: string } };

export type AnyEvent = {
	readonly type: string;
};

export const skillActivated = <E>(
	stream: Stream.Stream<AnyEvent, E>
): Stream.Stream<SkillActivated, E> =>
	stream.pipe(
		Stream.filter((event): event is SkillActivated => event.type === 'session.skill.activated')
	);

export const compacted = <E>(
	stream: Stream.Stream<AnyEvent, E>
): Stream.Stream<Compacted, E> =>
	stream.pipe(
		Stream.filter((event): event is Compacted => event.type === 'session.compacted')
	);

export const executionEnded = <E>(
	stream: Stream.Stream<AnyEvent, E>
): Stream.Stream<ExecutionEnded, E> =>
	stream.pipe(
		Stream.filter(
			(event): event is ExecutionEnded =>
				event.type === 'session.execution.succeeded' ||
				event.type === 'session.execution.failed' ||
				event.type === 'session.execution.interrupted'
		)
	);
