import { describe, expect, it } from 'vitest'
import { overall } from './Report.ts'

describe('overall', () => {
  it('error when check errored', () => {
    expect(overall({ checks: [{ verdict: 'error' }], skillEvidence: { status: 'sufficient' }, semantic: { status: 'passed' } })).toBe('error')
  })
  it('failed when evidence insufficient', () => {
    expect(overall({ checks: [{ verdict: 'passed' }], skillEvidence: { status: 'insufficient' }, semantic: { status: 'skipped' } })).toBe('failed')
  })
  it('never reports passed when nothing ran', () => {
    expect(overall({ checks: [], skillEvidence: { status: 'skipped' }, semantic: { status: 'skipped' } })).toBe('error')
  })
})
