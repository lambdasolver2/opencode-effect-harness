import { Effect, Layer } from 'effect'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { describe, expect, it } from 'vitest'

import { DEFAULT_ASSETS_ROOT, verifyAssetsManifest } from './index.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

describe('TypeScript asset manifest', () => {
  it('accepts the exact shipped inventory', async () => {
    const result = await Effect.runPromise(
      verifyAssetsManifest(DEFAULT_ASSETS_ROOT).pipe(Effect.provide(platform))
    )
    expect(result).toEqual({ ok: true })
  })

  it('rejects a missing manifest', async () => {
    const result = await Effect.runPromise(
      verifyAssetsManifest('/path-that-does-not-exist').pipe(Effect.provide(platform))
    )
    expect(result.ok).toBe(false)
  })
})
