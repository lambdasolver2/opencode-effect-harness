/**
 * Log — append-only experiment log as TSV rows. Pure codecs, round-trip safe
 * INCLUDING literal backslashes (escape order matters), with strict numeric
 * and boolean validation; malformed rows decode to undefined (never fabricated).
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

const escapeCell = (value: string): string =>
	value
		.replace(/\\/g, '\\\\')
		.replace(/\t/g, '\\t')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');

const unescapeCell = (value: string): string =>
	value.replace(/\\([\\trn])/g, (_, escaped: string) =>
		escaped === 't'
			? '\t'
			: escaped === 'n'
				? '\n'
				: escaped === 'r'
					? '\r'
					: '\\'
	);

export const header = (): string => HEADERS.join('\t');

export const encodeRow = (row: Row): string =>
	[
		escapeCell(row.timestamp),
		row.kind,
		escapeCell(row.blueprintId),
		escapeCell(row.modelProvider),
		escapeCell(row.modelName),
		escapeCell(row.taskId),
		String(row.score),
		row.passed ? '1' : '0',
		escapeCell(row.notes)
	].join('\t');

export const decodeRow = (line: string): Row | undefined => {
	const cells = line.split('\t');
	if (cells.length !== HEADERS.length) return undefined;
	const [timestamp, kind, blueprintId, modelProvider, modelName, taskId, score, passed, notes] =
		cells as [string, string, string, string, string, string, string, string, string];
	const validKinds = ['benchmark', 'evolution-commit', 'evolution-attempt'];
	const scoreNumber = Number(score);
	if (
		!validKinds.includes(kind) ||
		!Number.isFinite(scoreNumber) ||
		(passed !== '0' && passed !== '1')
	) {
		return undefined;
	}
	return new Row({
		timestamp: unescapeCell(timestamp),
		kind: kind as 'benchmark' | 'evolution-commit' | 'evolution-attempt',
		blueprintId: unescapeCell(blueprintId),
		modelProvider: unescapeCell(modelProvider),
		modelName: unescapeCell(modelName),
		taskId: unescapeCell(taskId),
		score: scoreNumber,
		passed: passed === '1',
		notes: unescapeCell(notes)
	});
};

export const encodeLog = (rows: ReadonlyArray<Row>): string =>
	[header(), ...rows.map(encodeRow)].join('\n');

export const decodeLog = (content: string): ReadonlyArray<Row> => {
	const lines = content.split('\n').filter((line) => line.length > 0);
	return lines.slice(1).flatMap((line) => {
		const row = decodeRow(line);
		return row === undefined ? [] : [row];
	});
};
