import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { boundedFromReader } from './Set.ts'

describe('boundedFromReader', () => {
  it('drops escapes and caps file content', async () => {
    const result = await Effect.runPromise(boundedFromReader(
      { projectRoot: '/project', paths: ['src/a.ts', '../secret.ts'] },
      (absolutePath) => Effect.succeed(
        absolutePath.endsWith('a.ts')
          ? Option.some('x'.repeat(40_000))
          : Option.none<string>()
      )
    ))

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.after).toHaveLength(32_000)
    expect(result.truncated).toBe(true)
  })
})
