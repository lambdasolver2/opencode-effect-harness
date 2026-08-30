/**
 * Syntax — TypeScript/TSX parse diagnostics via ast-grep.
 *
 * PURE syntax check only: tree-sitter `ERROR` / `MISSING` nodes report
 * UNPARSEABLE code. It does NOT typecheck and does NOT validate Effect API
 * usage — a syntactically valid snippet can still be wrong. Consumers must
 * combine this with compilation or rubric judgment; it must never be reported
 * as semantic verification.
 */
import { Lang, parse } from '@ast-grep/napi';
import { Option, Order, Schema } from 'effect';
import { sort } from 'effect/Array';

export class Diagnostic extends Schema.Class<Diagnostic>('SyntaxDiagnostic')({
	kind: Schema.Literals(['error', 'missing']),
	start: Schema.Number,
	end: Schema.Number,
	line: Schema.Number,
	column: Schema.Number,
	snippet: Schema.String
}) {}

const lineColumnOf = (source: string, index: number): { readonly line: number; readonly column: number } => {
	const before = source.slice(0, index);
	const line = before.split('\n').length;
	const lastBreak = before.lastIndexOf('\n');
	return { line, column: index - (lastBreak === -1 ? -1 : lastBreak) };
};

/** Map a file path to the ast-grep language; unknown extensions yield none. */
export const langOf = (filePath: string): Option.Option<Lang> => {
	if (filePath.endsWith('.tsx')) return Option.some(Lang.Tsx);
	if (filePath.endsWith('.ts')) return Option.some(Lang.TypeScript);
	if (filePath.endsWith('.jsx')) return Option.some(Lang.Tsx);
	if (filePath.endsWith('.js')) return Option.some(Lang.JavaScript);
	return Option.none();
};

interface AstNode {
	readonly is: (kind: string) => boolean;
	readonly children: () => ReadonlyArray<AstNode>;
	readonly range: () => {
		readonly start: { readonly index: number };
		readonly end: { readonly index: number };
	};
}

interface AstRootView {
	readonly root: () => AstNode;
}

/** Collect nodes of an exact tree-sitter kind by walking the tree (a string
 *  argument to `findAll` is a PATTERN query, not a kind selector). */
const collectByKind = (node: AstNode, kind: string): ReadonlyArray<AstNode> =>
	node.children().reduce<ReadonlyArray<AstNode>>(
		(acc, child) => [...acc, ...collectByKind(child, kind)],
		node.is(kind) ? [node] : []
	);

const nodesOf = (root: AstRootView, kind: string): ReadonlyArray<AstNode> =>
	collectByKind(root.root(), kind);

/**
 * Parse `source` as `lang` and return parse diagnostics ordered by position.
 * Never throws: an ast-grep internal failure surfaces as a single `error`
 * diagnostic covering the whole source, so callers can record it instead of
 * crashing.
 */
const parseRoot = Option.liftThrowable((lang: Lang, source: string): AstRootView => parse(lang, source));

export const diagnostics = (lang: Lang, source: string): ReadonlyArray<Diagnostic> => {
	const parsed = parseRoot(lang, source);
	if (Option.isNone(parsed)) {
		return [
			new Diagnostic({
				kind: 'error',
				start: 0,
				end: Math.max(1, source.length),
				line: 1,
				column: 1,
				snippet: (source.split('\n')[0] ?? '').slice(0, 200)
			})
		];
	}
	{
		const root = parsed.value;
		const errorNodes = [
			...nodesOf(root, 'ERROR').map((node) => ({ node, kind: 'error' as const })),
			...nodesOf(root, 'MISSING').map((node) => ({ node, kind: 'missing' as const }))
		];
		const found = errorNodes.map(({ node, kind }) => {
			const range = node.range();
			const start = range.start.index;
			const end = Math.max(start + 1, range.end.index);
			const lineColumn = lineColumnOf(source, start);
			return new Diagnostic({
				kind,
				start,
				end,
				line: lineColumn.line,
				column: lineColumn.column,
				snippet: source.slice(start, end).split('\n')[0] ?? ''
			});
		});
		return sort(found, Order.mapInput(Order.Number, (diagnostic: Diagnostic) => diagnostic.start));
	}
};

/** Convenience: parse diagnostics for a file-path/source pair. */
export const diagnosticsForFile = (
	filePath: string,
	source: string
): ReadonlyArray<Diagnostic> =>
	Option.match(langOf(filePath), {
		onNone: () => [],
		onSome: (lang) => diagnostics(lang, source)
	});
