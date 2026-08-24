import { describe, expect, it } from 'vitest'
import { Effect, Exit, Layer } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'

import { Env } from './Env.ts'

const platform = Layer.mergeAll(NodeFs.layer, NodePath.layer)

const tmpRoot = async (): Promise<string> => {
	const os = await import('node:os')
	const path = await import('node:path')
	const fs = await import('node:fs')
	return fs.promises.mkdtemp(path.join(os.tmpdir(), 'env-test-'))
}

const existsP = async (p: string): Promise<boolean> => {
	const fs = await import('node:fs')
	return fs.promises.access(p).then(() => true).catch(() => false)
}

describe('Env', () => {
	it('creates OWNED workspaces and destroy REMOVES them', async () => {
		const root = await tmpRoot()
		await Effect.runPromise(
			Effect.gen(function*() {
				const env = yield* Env.Tag
				const ws = yield* env.create({ taskId: 't1', modelLabel: 'm1', trial: 1 })
				expect(yield* Effect.promise(() => existsP(ws))).toBe(true)
				yield* env.destroy(ws)
				expect(yield* Effect.promise(() => existsP(ws))).toBe(false)
			}).pipe(Effect.provide(Env.layer({ root })), Effect.provide(platform))
		)
	})

	it('refuses to delete unowned or out-of-scope directories', async () => {
		const root = await tmpRoot()
		const os = await import('node:os')
		const path = await import('node:path')
		const fs = await import('node:fs')
		const foreign = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'foreign-'))
		const planted = path.join(root, '.workspaces', 'planted')
		await fs.promises.mkdir(planted, { recursive: true })
		await Effect.runPromise(
			Effect.gen(function*() {
				const env = yield* Env.Tag
				yield* env.destroy(foreign)
				expect(yield* Effect.promise(() => existsP(foreign))).toBe(true)
				yield* env.destroy(planted)
				expect(yield* Effect.promise(() => existsP(planted))).toBe(true)
			}).pipe(Effect.provide(Env.layer({ root })), Effect.provide(platform))
		)
	})

	it('fails loudly when fixtureDir does not exist', async () => {
		const root = await tmpRoot()
		await Effect.runPromise(
			Effect.gen(function*() {
				const env = yield* Env.Tag
				const exit = yield* env
					.create({ taskId: 't1', modelLabel: 'm1', trial: 1 })
					.pipe(Effect.exit)
				expect(Exit.isFailure(exit)).toBe(true)
			}).pipe(
				Effect.provide(Env.layer({ root, fixtureDir: `${root}/nope` })),
				Effect.provide(platform)
			)
		)
	})
})
