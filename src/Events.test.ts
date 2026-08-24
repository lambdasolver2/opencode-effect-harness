import { describe, expect, it } from 'vitest';

import { LiveTraceSink, selectExecutionEnded, selectSkillActivated } from './Events.ts';

describe('event selectors (pinned top-level data shape)', () => {
	it('selects execution.succeeded from data.sessionID', () => {
		expect(
			selectExecutionEnded({
				type: 'session.execution.succeeded',
				data: { sessionID: 'ses_1' }
			})
		).toEqual({ sessionID: 'ses_1', outcome: 'succeeded' });
	});

	it('still supports legacy properties wrapping', () => {
		expect(
			selectSkillActivated({
				type: 'session.skill.activated',
				properties: { data: { sessionID: 'ses_2', name: 'effect-x' } }
			})
		).toEqual({ sessionID: 'ses_2', name: 'effect-x' });
	});

	it('selects skill activation from top-level data.name', () => {
		expect(
			selectSkillActivated({
				type: 'session.skill.activated',
				data: { sessionID: 'ses_3', name: 'effect-y' }
			})
		).toEqual({ sessionID: 'ses_3', name: 'effect-y' });
	});

	it('ignores unrelated types', () => {
		expect(selectExecutionEnded({ type: 'session.updated' })).toBeUndefined();
	});
});

describe('LiveTraceSink.feed', () => {
	it('records text parts delivered under top-level data.part', () => {
		const sink = LiveTraceSink.make();
		LiveTraceSink.feed(sink, {
			type: 'message.part.updated',
			data: { sessionID: 'ses_9', part: { type: 'text', text: 'hello' } }
		});
		expect(sink.lastAssistantText('ses_9')).toBe('hello');
	});
});
