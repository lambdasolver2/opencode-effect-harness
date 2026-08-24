import { describe, expect, it } from 'vitest';

import {
	computeChangedSpans,
	extractAffectedPaths,
	extractPatchPaths,
	resolveAffected
} from './Snapshots.ts';

describe('computeChangedSpans', () => {
	it('spans only the inserted region', () => {
		const before = 'alpha\nbeta\ngamma';
		const after = 'alpha\nBETA!\ngamma';
		const spans = computeChangedSpans(before, after);
		expect(spans).toHaveLength(1);
		// diffLines is line-granular: the added chunk carries its newline.
		expect(after.slice(spans[0]!.start, spans[0]!.end)).toBe('BETA!\n');
	});

	it('treats an unknown before-content as fully changed', () => {
		const after = 'fresh';
		expect(computeChangedSpans(undefined, after)).toEqual([
			{ start: 0, end: after.length }
		]);
	});

	it('returns no spans when content is unchanged', () => {
		expect(computeChangedSpans('same', 'same')).toEqual([]);
	});
});

describe('extractPatchPaths', () => {
	it('collects Add/Update/Delete/Move targets and dedupes', () => {
		const patch = [
			'*** Begin Patch',
			'*** Add File: a.ts',
			'*** Update File: b.ts',
			'*** Delete File: c.ts',
			'*** Move to: d.ts',
			'*** Update File: b.ts',
			'*** End Patch'
		].join('\n');
		expect(extractPatchPaths(patch)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
	});
});

describe('extractAffectedPaths', () => {
	it('reads structured tool inputs', () => {
		expect(extractAffectedPaths('write', { path: 'x.ts', content: 'y' })).toEqual(['x.ts']);
		expect(extractAffectedPaths('edit', { filePath: 'z.ts' })).toEqual(['z.ts']);
	});
	it('falls back to patch-text paths for patch tools', () => {
		expect(
			extractAffectedPaths('apply_patch', { patchText: '*** Add File: p.q\n' })
		).toEqual(['p.q']);
	});
});

describe('resolveAffected', () => {
	it('resolves contained paths and reports escapes separately', () => {
		const { snapshots, escaped } = resolveAffected('/proj', ['a.ts', '../evil']);
		expect(snapshots.map((s) => [s.filePath, s.absolutePath])).toEqual([
			['a.ts', '/proj/a.ts']
		]);
		expect(escaped).toEqual(['../evil']);
	});
});
