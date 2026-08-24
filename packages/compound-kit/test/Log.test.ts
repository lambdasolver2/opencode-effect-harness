/**
 * ExperimentLog TSV codecs: round-trip safety, escaping, malformed rejection.
 */
import { describe, expect, it } from 'vitest';

import { decodeLog, decodeRow, encodeLog, encodeRow, header } from '../src/Log.ts';
import { Row } from '../src/Log.ts';

const sample = (): Row =>
	new Row({
		timestamp: '2026-01-01T00:00:00Z',
		kind: 'benchmark',
		blueprintId: 'bp-1',
		modelProvider: 'openai',
		modelName: 'gpt-5',
		taskId: 'task-1',
		score: 0.85,
		passed: true,
		notes: 'clean run'
	});

describe('Log TSV codecs', () => {
	it('round-trips a single row', () => {
		const row = sample();
		const decoded = decodeRow(encodeRow(row));
		expect(decoded).toBeDefined();
		expect(decoded?.blueprintId).toBe('bp-1');
		expect(decoded?.score).toBe(0.85);
		expect(decoded?.passed).toBe(true);
	});

	it('escapes tabs and newlines in notes', () => {
		const row = new Row({
			...sample(),
			notes: 'has\ttab and\nnewline'
		});
		const encoded = encodeRow(row);
		const cells = encoded.split('\t');
		expect(cells.length).toBe(9); // no extra columns from embedded tabs

		const decoded = decodeRow(encoded);
		expect(decoded?.notes).toBe('has\ttab and\nnewline');
	});

	it('round-trips a full log with header', () => {
		const rows = [sample(), new Row({ ...sample(), kind: 'evolution-commit', score: 0.9 })];
		const log = encodeLog(rows);
		const lines = log.split('\n');
		expect(lines[0]).toContain('timestamp');
		expect(lines).toHaveLength(3);

		const decoded = decodeLog(log);
		expect(decoded).toHaveLength(2);
		expect(decoded[1]?.kind).toBe('evolution-commit');
	});

	it('returns undefined for malformed rows', () => {
		expect(decodeRow('too\tfew')).toBeUndefined();
		expect(decodeRow('bad\tkind\tvalue\ta\tb\tc\t0.5\t1\tnotes')).toBeUndefined();
	});

	it('skips malformed lines when decoding a log', () => {
		const content = [
			header(),
			encodeRow(sample()),
			'garbage-line-no-tabs',
			encodeRow(new Row({ ...sample(), blueprintId: 'bp-2' }))
		].join('\n');
		const decoded = decodeLog(content);
		expect(decoded).toHaveLength(2);
	});
});
