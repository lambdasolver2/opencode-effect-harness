import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { CatalogError } from 'opencode-harness-kit/Catalog.ts'
import { Orchestrator } from './Orchestrator.ts'
import { VerifyRequest } from './Report.ts'

const request = new VerifyRequest({
  sessionID: 'session',
  projectKey: 'project',
  projectRoot: '/project',
  touchedFiles: ['src/index.ts'],
  trigger: 'manual',
  loadedSkills: [],
  minSkillEvidence: 0
})

const exec = { run: () => Effect.die('checker should not run') } as never
const registry = { resolve: () => Effect.succeed([]) } as never

const moduleWith = (detectors: Effect.Effect<ReadonlyArray<never>, CatalogError>) => ({
  id: 'test',
  languages: ['typescript'],
  appliesTo: () => true,
  checkers: () => Effect.succeed([]),
  patterns: { root: '/project', detectors: () => detectors }
})

describe('Orchestrator integrity states', () => {
  it('marks an unavailable reader as a scan error', async () => {
    const report = await Effect.runPromise(Orchestrator.verify(
      { registry, exec },
      request,
      [moduleWith(Effect.succeed([]))]
    ))
    expect(report.patternScanStatus).toBe('error')
    expect(report.patternScanError).toContain('readFile')
  })

  it('marks an unavailable catalog as a scan error', async () => {
    const report = await Effect.runPromise(Orchestrator.verify(
      { registry, exec, readFile: () => Effect.succeed('') },
      request,
      [moduleWith(Effect.fail(new CatalogError({ path: '/patterns', reason: 'missing' })))]
    ))
    expect(report.patternScanStatus).toBe('error')
    expect(report.patternScanError).toContain('pattern catalog unavailable')
  })

  it('exposes module construction failures in the report', async () => {
    const report = await Effect.runPromise(Orchestrator.verify(
      { registry, exec, moduleLoadFailures: [{ moduleId: 'typescript', reason: 'drift' }] },
      request,
      []
    ))
    expect(report.moduleLoadFailures).toEqual([{ moduleId: 'typescript', reason: 'drift' }])
  })
})
