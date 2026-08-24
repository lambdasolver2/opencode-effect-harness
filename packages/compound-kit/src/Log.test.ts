import { describe, expect, it } from 'vitest'
import { Row, encodeRow, decodeRow } from './Log.ts'

describe('Log TSV codecs', () => {
  it('round-trips rows', () => {
    const row = new Row({ timestamp: '2026-01-01T00:00:00Z', kind: 'benchmark', blueprintId: 'bp-1', modelProvider: 'openai', modelName: 'gpt-5', taskId: 'task-1', score: 0.85, passed: true, notes: 'clean' })
    const decoded = decodeRow(encodeRow(row))
    expect(decoded?.score).toBe(0.85)
  })
  it('escapes backslashes before tabs', () => {
    const row = new Row({ timestamp: 't', kind: 'benchmark', blueprintId: 'b', modelProvider: 'm', modelName: 'g', taskId: 't', score: 0, passed: false, notes: 'back\\slash\ttab' })
    expect(decodeRow(encodeRow(row))?.notes).toBe(row.notes)
  })
})
