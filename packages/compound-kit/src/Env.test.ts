import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { Env } from './Env.ts'

describe('Env', () => {
  it('creates unique workspaces and destroys them', async () => {
    const root = (await import('node:os')).tmpdir()
    const program = Effect.gen(function*() {
      const env = yield* Env.Tag
      const a = yield* env.create({ taskId: 't1', modelLabel: 'm', trial: 1 })
      const b = yield* env.create({ taskId: 't1', modelLabel: 'm', trial: 1 })
      expect(a).not.toBe(b)
      yield* env.destroy(a); yield* env.destroy(b)
    }).pipe(Effect.provide(Env.layer({ root }).pipe(Layer.provide(Layer.mergeAll(NodeFs.layer, NodePath.layer)))))
    await Effect.runPromise(program)
  })
})
