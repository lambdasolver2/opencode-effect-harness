import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { findPatternMatches, stripComments } from './Matcher.ts'
import { Input } from './Input.ts'
import { Pattern } from './Pattern.ts'

const mkInput = (filePath?: string, content?: string): Input.Value =>
	new Input.Value({
		filePath: filePath === undefined ? Option.none() : Option.some(filePath),
		content: content === undefined ? Option.none() : Option.some(content),
		changedSpans: Option.none(), command: Option.none(), pattern: Option.none(),
		query: Option.none(), url: Option.none(), prompt: Option.none()
	})

const rp = (name: string, pattern: string, glob?: string): Pattern.Value =>
	new Pattern.Value({ name, description: 't', event: 'after', toolRegex: '(write|edit)', level: 'warning',
		...(glob === undefined ? {} : { glob }), detector: new Pattern.RegexDetector({ pattern, matchInComments: false }),
		guidance: 'g', sourcePath: `${name}.md` })

describe('stripComments', () => {
	it('removes line comments but keeps strings', () => {
		const s = stripComments('const u = "http://x"; // comment\n')
		expect(s).toContain('"http://x"')
		expect(s).not.toContain('comment')
	})
	it('preserves offsets', () => {
		const src = 'a; // c\nb;'
		expect(stripComments(src).length).toBe(src.length)
	})
})

describe('regex detector', () => {
	it('matches after-event writes', () => {
		const p = rp('no-env', 'process\\.env')
		const m = findPatternMatches('write', mkInput('src/e.ts', 'process.env.X'), 'after', p)
		expect(m).toHaveLength(1)
	})
	it('honors glob filters', () => {
		const p = rp('ts-only', 'TODO', '**/*.ts')
		expect(findPatternMatches('write', mkInput('src/r.md', 'TODO'), 'after', p)).toHaveLength(0)
	})
})
