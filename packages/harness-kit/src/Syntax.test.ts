import { describe, expect, it } from 'vitest'
import { Lang } from '@ast-grep/napi'
import { Option } from 'effect'

import { diagnostics, diagnosticsForFile, langOf } from './Syntax.ts'

describe('Syntax (ast-grep parse diagnostics)', () => {
	it('passes valid TypeScript with zero diagnostics', () => {
		expect(diagnostics(Lang.TypeScript, 'const x: number = 1;')).toHaveLength(0)
	})

	it('flags an unparseable expression as an ERROR diagnostic', () => {
		const found = diagnostics(Lang.TypeScript, 'const x =')
		expect(found.length).toBeGreaterThan(0)
		expect(found[0]?.kind).toBe('error')
	})

	it('flags an unterminated object literal', () => {
		expect(diagnostics(Lang.TypeScript, 'const x = {').length).toBeGreaterThan(0)
	})

	it('maps file paths to languages and ignores unknown extensions', () => {
		const ts = langOf('a.ts')
		expect(Option.isSome(ts) && ts.value === Lang.TypeScript).toBe(true)
		const tsx = langOf('a.tsx')
		expect(Option.isSome(tsx) && tsx.value === Lang.Tsx).toBe(true)
		expect(Option.isNone(langOf('a.md'))).toBe(true)
		expect(diagnosticsForFile('a.md', 'const x =')).toHaveLength(0)
		expect(diagnosticsForFile('a.tsx', 'const x =').length).toBeGreaterThan(0)
	})

	it('never throws on pathological input', () => {
		expect(diagnostics(Lang.TypeScript, '').length).toBe(0)
		expect(diagnosticsForFile('a.ts', '\n\n  ').length).toBe(0)
	})
})
