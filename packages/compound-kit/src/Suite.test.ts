import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import * as NodeFs from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'

import { Runner } from './Suite.ts'

describe('Runner', () => {
	it('module exports are well-formed', () => {
		expect(Runner.Tag).toBeDefined()
		expect(typeof Runner.layer).toBe('function')
	})
})
