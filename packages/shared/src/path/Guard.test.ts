import { describe, expect, it } from 'vitest';

import { partitionWithinRoot, withinRoot } from './Guard.ts';

describe('withinRoot', () => {
	const root = '/workspaces/proj';

	it('joins relative paths under the root', () => {
		expect(withinRoot(root, 'src/a.ts')).toBe('/workspaces/proj/src/a.ts');
		expect(withinRoot(root, './src/./b.ts')).toBe('/workspaces/proj/src/b.ts');
	});

	it('accepts absolute paths inside the root', () => {
		expect(withinRoot(root, '/workspaces/proj/src/a.ts')).toBe(
			'/workspaces/proj/src/a.ts'
		);
	});

	it('rejects traversal escaping the root', () => {
		expect(withinRoot(root, '../secret')).toBeUndefined();
		expect(withinRoot(root, 'a/../../escape')).toBeUndefined();
	});

	it('rejects sibling prefixes that merely share characters', () => {
		expect(withinRoot(root, '/workspaces/proj-evil/x')).toBeUndefined();
	});
});

describe('partitionWithinRoot', () => {
	it('partitions contained vs escaped', () => {
		const { contained, escaped } = partitionWithinRoot('/r', ['ok.ts', '../x']);
		expect(contained).toEqual(['/r/ok.ts']);
		expect(escaped).toEqual(['../x']);
	});
});
