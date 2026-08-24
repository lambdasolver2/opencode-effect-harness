/**
 * Frontmatter parsing tests — the quoting pre-processor must keep regex
 * patterns with YAML-hostile characters parseable.
 */
import { describe, expect, it } from 'vitest';

import { extractBody, parseFrontmatter } from '../src/kernel/services/Catalog.ts';

describe('FrontMatter', () => {
	it('parses simple key/value frontmatter', () => {
		const raw = '---\nname: my-pattern\nlevel: warning\n---\n\n# Body\n';
		const fm = parseFrontmatter(raw);
		expect(fm.name).toBe('my-pattern');
		expect(fm.level).toBe('warning');
		expect(extractBody(raw)).toBe('# Body');
	});

	it('quotes unquoted regex values containing YAML indicators', () => {
		const raw = [
			'---',
			'name: avoid-any',
			'pattern: $A as any',
			'tool: (edit|write)',
			'---',
			''
		].join('\n');
		const fm = parseFrontmatter(raw);
		expect(fm.pattern).toBe('$A as any');
		expect(fm.tool).toBe('(edit|write)');
	});

	it('leaves already-quoted values untouched', () => {
		const raw = '---\npattern: "$A as any"\n---\n';
		expect(parseFrontmatter(raw).pattern).toBe('$A as any');
	});

	it('returns an empty record when there is no frontmatter', () => {
		expect(parseFrontmatter('# just markdown\n')).toEqual({});
	});

	it('returns an empty record for malformed yaml instead of throwing', () => {
		const raw = '---\n: : : broken [\n---\nbody\n';
		expect(() => parseFrontmatter(raw)).not.toThrow();
	});
});
