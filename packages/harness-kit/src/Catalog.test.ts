import { describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { loadPatterns } from './Catalog.ts'

const platform = Layer.mergeAll(NodeFs.layer, NodePath.layer)
const ASSETS = new URL('../../module-typescript/assets/', import.meta.url).pathname.replace(/\/$/, '')

describe('Catalog', () => {
	it('loads the full 46-pattern inventory', async () => {
		const patterns = await Effect.runPromise(loadPatterns(`${ASSETS}/patterns`).pipe(Effect.provide(platform)))
		expect(patterns.length).toBe(47)
		for (const p of patterns) {
			expect(p.name.length).toBeGreaterThan(0)
			expect(p.guidance.length).toBeGreaterThan(0)
		}
	})
})
