import { describe, expect, it } from 'vitest'
import { Effect, Layer, Option } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { Projection } from './Projection.ts'
import { Intent } from './Intent.ts'

const platform = Layer.mergeAll(NodeFs.layer, NodePath.layer)
const projectionOf = <A>(use: (p: Projection.Interface) => Effect.Effect<A>): Effect.Effect<A> =>
	Projection.Service.use(use).pipe(Effect.provide(Projection.layer.pipe(Layer.provide(platform))))

describe('Projection', () => {
	it('projects write content as-is', async () => {
		const intent = new Intent.WriteFile({ phase: 'before', filePath: 'src/new.ts', content: 'export const x = 1;\n' })
		const out = await Effect.runPromise(projectionOf((p) => p.prospective('/tmp', intent)))
		expect(Option.getOrElse(out.content, () => '')).toBe('export const x = 1;\n')
	})

	it('returns degraded state on ambiguous edits', async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
		const { join } = await import('node:path')
		const os = await import('node:os')
		const dir = mkdtempSync(join(os.tmpdir(), 'proj-'))
		writeFileSync(join(dir, 'dupe.ts'), 'const a = f();\nconst b = f();\n')
		try {
			const intent = new Intent.EditFile({
				phase: 'before', filePath: join(dir, 'dupe.ts'),
				replacements: [{ oldText: 'f();', newText: 'g();' }] as never
			})
			const out = await Effect.runPromise(projectionOf((p) => p.prospective(dir, intent)))
			expect(Option.isNone(out.content)).toBe(true)
			expect(out.projectionError).toBe('ambiguous-old-text')
		} finally { rmSync(dir, { recursive: true, force: true }) }
	})
})
