import { describe, expect, it } from 'vitest'
import { decode, defaults } from './Options.ts'
import { Effect } from 'effect'

describe('Options', () => {
  it('applies defaults for empty config', async () => {
    const config = await Effect.runPromise(decode({}))
    expect(config.harness.minEffectSkills).toBe(4)
  })
  it('rejects impossible critic cadence combination', async () => {
    const exit = await Effect.runPromiseExit(decode({ critic: { autoAfterExplicitCheckpoint: true, autoEveryNBuildExecutions: 5 } }))
    expect(exit._tag).toBe('Failure')
  })
})
