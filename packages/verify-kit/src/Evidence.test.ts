import { describe, expect, it } from 'vitest'
import { assessEvidence } from './Evidence.ts'

describe('assessEvidence', () => {
  it('returns skipped when minRequired <= 0', () => {
    expect(assessEvidence({ codeDetected: true, loadedSkills: ['a'], minRequired: 0 }).status).toBe('skipped')
  })
  it('returns sufficient when enough distinct skills', () => {
    const r = assessEvidence({ codeDetected: true, loadedSkills: ['effect-a', 'effect-b'], minRequired: 2 })
    expect(r.status).toBe('sufficient')
  })
  it('returns insufficient when not enough skills', () => {
    expect(assessEvidence({ codeDetected: true, loadedSkills: ['a'], minRequired: 4 }).status).toBe('insufficient')
  })
})
