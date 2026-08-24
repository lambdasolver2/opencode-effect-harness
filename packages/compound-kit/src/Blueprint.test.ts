import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import { BlueprintModule, composeBlueprints, PromptDraft, Patch, applyPatches, ModelExecutionSpec } from './Blueprint.ts'

describe('composeBlueprints', () => {
  it('composes modules in order', async () => {
    const mods = [
      new BlueprintModule({ id: 'a', version: '1', prompt: 'A', appliesWhen: [], provides: [], conflicts: [], failureModes: [], recovery: [], evidence: [] }),
      new BlueprintModule({ id: 'b', version: '1', prompt: 'B', appliesWhen: [], provides: [], conflicts: [], failureModes: [], recovery: [], evidence: [] }),
    ]
    const result = await Effect.runPromise(composeBlueprints(mods, [{ id: 'a', version: '1', required: true }, { id: 'b', version: '1', required: true }]))
    expect(result.fragments).toHaveLength(2)
  })
})

describe('applyPatches', () => {
  it('adds steps immutably', () => {
    const draft = new PromptDraft({ blueprintId: 'bp', systemPrompt: 's', procedure: ['a'], pitfalls: [], execution: new ModelExecutionSpec({ workerAgent: 'x', tools: [], maxTurns: 5, timeoutMs: 60000 }) })
    const next = applyPatches(draft, [new Patch({ blueprintId: 'bp', description: 'd', changes: [{ _tag: 'add-procedure-step', value: 'b' }] })])
    expect(next.procedure).toEqual(['a', 'b'])
    expect(draft.procedure).toEqual(['a'])
  })
})
