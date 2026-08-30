import { describe, expect, it } from 'vitest'
import { Effect, Layer, Option } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'

import { loadPatterns } from './Catalog.ts'
import { findPatternMatches } from './Matcher.ts'
import { Input } from './Input.ts'
import { Pattern } from './Pattern.ts'

const platform = Layer.mergeAll(NodeFs.layer, NodePath.layer)
const ASSETS = new URL('../../module-typescript/assets/', import.meta.url).pathname.replace(/\/$/, '')

const patternsP = Effect.runPromise(loadPatterns(`${ASSETS}/patterns`).pipe(Effect.provide(platform)))

const byName = async (name: string): Promise<Pattern.Value> => {
	const patterns = await patternsP
	const found = patterns.find((p) => p.name === name)
	if (found === undefined) throw new Error(`pattern not shipped: ${name}`)
	return found
}

const input = (filePath: string, content: string): Input.Value =>
	new Input.Value({
		filePath: Option.some(filePath),
		content: Option.some(content),
		changedSpans: Option.none(), command: Option.none(), pattern: Option.none(),
		query: Option.none(), url: Option.none(), prompt: Option.none()
	})

const matches = async (name: string, filePath: string, content: string): Promise<number> =>
	findPatternMatches('write', input(filePath, content), 'after', await byName(name)).length

describe('shipped detectors (catalog-backed smoke)', () => {
	it('imperative-loops fires on for/while and passes functional code', async () => {
		const file = 'src/loop.ts'
		expect(await matches('imperative-loops', file, 'for (const x of xs) { sink(x) }')).toBeGreaterThan(0)
		expect(await matches('imperative-loops', file, 'while (done === false) { step() }')).toBeGreaterThan(0)
		expect(await matches('imperative-loops', file, 'xs.map((x) => sink(x))')).toBe(0)
	})

	it('avoid-direct-json fires on JSON.parse/stringify and passes Schema codecs', async () => {
		const file = 'src/json.ts'
		expect(await matches('avoid-direct-json', file, 'const v = JSON.parse(raw)')).toBeGreaterThan(0)
		expect(await matches('avoid-direct-json', file, 'const s = JSON.stringify(v)')).toBeGreaterThan(0)
		expect(await matches('avoid-direct-json', file, 'const v = Schema.decodeUnknownSync(S) (raw)')).toBe(0)
	})

	it('throw-in-effect-gen fires on thrown errors inside Effect.gen', async () => {
		const file = 'src/gen.ts'
		expect(
			await matches('throw-in-effect-gen', file, 'Effect.gen(function*() { throw new Error("x") })')
		).toBeGreaterThan(0)
	})

	it('avoid-process-env fires on process.env access', async () => {
		const file = 'src/env.ts'
		expect(await matches('avoid-process-env', file, 'const key = process.env.API_KEY')).toBeGreaterThan(0)
	})

	it('prefer-recursion-over-while (documented LOCAL addition) fires on while loops', async () => {
		expect(
			await matches('prefer-recursion-over-while', 'src/paginate.ts', 'while (hasMore) { page = await fetchNext() }')
		).toBeGreaterThan(0)
	})

	it('detectors do not fire on comments when matchInComments is false', async () => {
		const file = 'src/commented.ts'
		expect(await matches('avoid-process-env', file, '// process.env.HINT is not real access')).toBe(0)
	})
})
