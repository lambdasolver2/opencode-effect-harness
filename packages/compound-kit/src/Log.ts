/**
 * Log — append-only experiment log as TSV rows. Pure codecs (round-trip safe).
 */
import { Schema } from 'effect';

export class Row extends Schema.Class<Row>('ExperimentRow')({
	timestamp: Schema.String,
	kind: Schema.Literals(['benchmark', 'evolution-commit', 'evolution-attempt']),
	blueprintId: Schema.String,
	modelProvider: Schema.String,
	modelName: Schema.String,
	taskId: Schema.String,
	score: Schema.Number,
	passed: Schema.Boolean,
	notes: Schema.String
}) {}

const HEADERS = [
	'timestamp',
	'kind',
	'blueprintId',
	'modelProvider',
	'modelName',
	'taskId',
	'score',
	'passed',
	'notes'
] as const;

const escapeCell = (value: string): string => value.replace(/\t/g, '\\t').replace(/\n/g, '\\n');
const unescapeCell = (value: string): string => value.replace(/\\t/g, '\t').replace(/\\n/g, '\n');

export const header = (): string => HEADERS.join('\t');

/** Encode one row to a TSV line. */
export const encodeRow = (row: Row): string =>
	[
		row.timestamp,
		row.kind,
		row.blueprintId,
		row.modelProvider,
		row.modelName,
		row.taskId,
		String(row.score),
		row.passed ? '1' : '0',
		escapeCell(row.notes)
	].join('\t');

/** Decode a TSV line back to a Row. Returns undefined on malformed lines. */
export const decodeRow = (line: string): Row | undefined => {
	const cells = line.split('\t');
	if (cells.length !== HEADERS.length) return undefined;
	const [timestamp, kind, blueprintId, modelProvider, modelName, taskId, score, passed, notes] =
		cells as [string, string, string, string, string, string, string, string, string];
	if (
		!['benchmark', 'evolution-commit', 'evolution-attempt'].includes(kind)
	) {
		return undefined;
	}
	return new Row({
		timestamp,
		kind: kind as 'benchmark' | 'evolution-commit' | 'evolution-attempt',
		blueprintId,
		modelProvider,
		modelName,
		taskId,
		score: Number(score),
		passed: passed === '1',
		notes: unescapeCell(notes)
	});
};

/** Encode a full log (header + rows). */
export const encodeLog = (rows: ReadonlyArray<Row>): string =>
	[header(), ...rows.map(encodeRow)].join('\n');

/** Decode full TSV content; skips the header row and malformed lines. */
export const decodeLog = (content: string): ReadonlyArray<Row> => {
	const lines = content.split('\n').filter((line) => line.length > 0);
	return lines.slice(1).flatMap((line) => {
		const row = decodeRow(line);
		return row === undefined ? [] : [row];
	});
};
