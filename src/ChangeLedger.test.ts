import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { ChangeLedger } from './ChangeLedger.ts'

describe('ChangeLedger', () => {
  it('records and drains per session', async () => {
    const ledger = ChangeLedger.make()
    await Effect.runPromise(ledger.record({ projectKey: 'p', sessionID: 's1', filePath: 'a.ts' }))
    const files = await Effect.runPromise(ledger.drain({ projectKey: 'p', sessionID: 's1' }))
    expect(files).toEqual(['a.ts'])
    const after = await Effect.runPromise(ledger.drain({ projectKey: 'p', sessionID: 's1' }))
    expect(after).toEqual([])
  })
})


describe('ChangeLedger peek', () => {
	it('reads without clearing so failed verification retains changes', async () => {
		const { Effect } = await import('effect');
		const ledger = ChangeLedger.make();
		await Effect.runPromise(
			ledger.record({ projectKey: 'pk', sessionID: 'sid', filePath: 'a.ts' })
		);
		expect(
			await Effect.runPromise(ledger.peek({ projectKey: 'pk', sessionID: 'sid' }))
		).toEqual(['a.ts']);
		expect(
			await Effect.runPromise(ledger.peek({ projectKey: 'pk', sessionID: 'sid' }))
		).toEqual(['a.ts']);
		expect(await Effect.runPromise(ledger.drain({ projectKey: 'pk', sessionID: 'sid' }))).toEqual(['a.ts']);
		expect(await Effect.runPromise(ledger.peek({ projectKey: 'pk', sessionID: 'sid' }))).toEqual([]);
	});
});
