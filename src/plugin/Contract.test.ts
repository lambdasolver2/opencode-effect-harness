import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import plugin from '../index.ts'

describe('OpenCode plugin contract', () => {
  it('registers tools, skill transform, and lifecycle hooks', async () => {
    const toolNames: Array<string> = []
    const toolHooks: Array<string> = []
    const sessionHooks: Array<string> = []
    const registeredSkills: Array<unknown> = []
    const tools = {
      add: (tool: { name: string }) => toolNames.push(tool.name)
    }
    const context = {
      options: {},
      session: {
        get: () => Effect.succeed({ location: { directory: process.cwd() } }),
        create: () => Effect.succeed({ id: 'child' }),
        prompt: () => Effect.succeed(undefined),
        wait: () => Effect.succeed(undefined),
        hook: (name: string) => {
          sessionHooks.push(name)
          return Effect.succeed(undefined)
        }
      },
      storage: {
        get: () => Effect.succeed(undefined),
        set: () => Effect.succeed(undefined)
      },
      skill: {
        transform: (f: (draft: { add: (skill: unknown) => void }) => void) => {
          f({ add: (skill) => registeredSkills.push(skill) })
          return Effect.succeed(undefined)
        }
      },
      tool: {
        transform: (f: (input: typeof tools) => void) => {
          f(tools)
          return Effect.succeed(undefined)
        },
        hook: (name: string) => {
          toolHooks.push(name)
          return Effect.succeed(undefined)
        }
      },
      event: { subscribe: () => Stream.empty },
      agent: {
        transform: (f: (draft: { list: () => ReadonlyArray<unknown> }) => void) => {
          f({ list: () => [] })
          return Effect.succeed(undefined)
        }
      },
      app: {}, aisdk: {}, catalog: {}, command: {}, integration: {},
      mcp: {}, plugin: {}, reference: {}, shell: {}, websearch: {}
    }

    await Effect.runPromise(
      Effect.scoped(plugin.effect(context as never) as Effect.Effect<void, never>)
    )

    expect(toolNames).toEqual([
      'effect_harness_verify',
      'effect_harness_critic',
      'harness_skill_stats',
      'harness_toggle',
      'effect_harness_compound'
    ])
    expect(registeredSkills.length).toBeGreaterThan(0)
    expect(toolHooks).toEqual(['execute.before', 'execute.after'])
    expect(sessionHooks).toEqual(['context'])
  })
})
