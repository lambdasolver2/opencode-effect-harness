import { describe, expect, it } from 'vitest'
import { Effect, Option } from 'effect'
import { Gate } from './Gate.ts'
import { Decision } from '../Decision.ts'
import { Input } from '../Input.ts'
import { Intent } from '../Intent.ts'

const makeGate = (strictAgents: ReadonlyArray<string>, failClosed = true) =>
	Gate.rule({
		min: 4, strictAgents, failClosed,
		reason: (l) => Effect.succeed(`blocked ${String(l)}`),
		loaded: () => Effect.succeed(2),
		project: (_cwd, i) => Effect.succeed(
			new Input.Value({
				filePath: Option.some('src/x.ts'), content: Option.some(typeof i === 'object' && i !== null && 'content' in i ? String((i as { content: string }).content) : ''),
				changedSpans: Option.none(), command: Option.none(), pattern: Option.none(),
				query: Option.none(), url: Option.none(), prompt: Option.none()
			})
		)
	})

const intent = (content: string) =>
	new Intent.WriteFile({ phase: 'before', filePath: 'src/x.ts', content })

describe('Gate', () => {
	it('blocks strict agent below threshold', async () => {
		const decisions = await Effect.runPromise(
			makeGate(['build']).evaluate({
				activeBranch: { entries: [] } as never, cwd: '/p',
				agent: 'build', sessionId: 's1',
				writeIntent: intent('import { Effect } from "effect";') as never
			})
		)
		expect(decisions).toHaveLength(1)
		expect(decisions[0]?._tag).toBe('BlockToolCall')
	})

	it('is advisory for non-strict agents', async () => {
		const decisions = await Effect.runPromise(
			makeGate(['build']).evaluate({
				activeBranch: { entries: [] } as never, cwd: '/p',
				agent: 'plan', sessionId: 's1',
				writeIntent: intent('Effect.succeed(1)') as never
			})
		)
		expect(decisions).toEqual([])
	})
})
