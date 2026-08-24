import type { Schema } from 'effect';
import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Order,
	Path
} from 'effect';
import { sort } from 'effect/Array';

import { Edit } from './Edit.ts';
import { Intent } from './Intent.ts';
import { Input } from './Input.ts';
import { normalizePath } from './Normalize.ts';

type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

interface ReplacementSpan {
	readonly newText: string;
	readonly span: Edit.Span;
}

interface ProjectedContent {
	readonly content: string;
	readonly changedSpans: ReadonlyArray<Edit.Span>;
}

const none = <A>() => Option.none<A>();

const stringOption = (value: string | undefined): Option.Option<string> =>
	value === undefined ? none() : Option.some(value);

const property = (value: unknown, key: PropertyKey): unknown =>
	value !== null && typeof value === 'object'
		? Reflect.get(value, key)
		: undefined;

const getFilePath = (input: unknown): Option.Option<string> =>
	['path', 'filePath']
		.map((key) => property(input, key))
		.flatMap((value) => (typeof value === 'string' ? [Option.some(value)] : []))
		.at(0) ?? Option.none();

const nonEmptyStringOption = (value: unknown): Option.Option<string> =>
	typeof value === 'string' && value.length > 0 ? Option.some(value) : none();

const anyStringOption = (value: unknown): Option.Option<string> =>
	typeof value === 'string' ? Option.some(value) : none();

const fullChangedSpan = (content: string): ReadonlyArray<Edit.Span> => [
	new Edit.Span({ start: 0, end: content.length })
];

const buildInput = (input: {
	readonly filePath: Option.Option<string>;
	readonly command: Option.Option<string>;
	readonly content: Option.Option<string>;
	readonly changedSpans: Option.Option<ReadonlyArray<Edit.Span>>;
	readonly pattern: Option.Option<string>;
	readonly prompt: Option.Option<string>;
	readonly query: Option.Option<string>;
	readonly url: Option.Option<string>;
	readonly projectionError?: string | undefined;
}) =>
	new Input.Value({
		filePath: input.filePath,
		content: input.content,
		changedSpans: input.changedSpans,
		command: input.command,
		pattern: input.pattern,
		query: input.query,
		url: input.url,
		prompt: input.prompt,
		...(input.projectionError !== undefined
			? { projectionError: input.projectionError }
			: {})
	});

const withFile = (
	filePath: Option.Option<string>,
	content: Option.Option<string>,
	changedSpans: Option.Option<ReadonlyArray<Edit.Span>> = none(),
	projectionError?: string
): Input.Value =>
	buildInput({
		filePath,
		command: none(),
		content,
		changedSpans,
		pattern: none(),
		prompt: none(),
		query: none(),
		url: none(),
		projectionError
	});

const rawProjection = (input: unknown): Input.Value => {
	const edits = property(input, 'edits');
	const editContent = Array.isArray(edits)
		? edits.reduce<ReadonlyArray<string>>((parts, edit) => {
			const oldText = nonEmptyStringOption(property(edit, 'oldText'));
			const newText = nonEmptyStringOption(property(edit, 'newText'));
			return [
				...parts,
				...(Option.isSome(oldText) ? [oldText.value] : []),
				...(Option.isSome(newText) ? [newText.value] : [])
			];
		}, [])
		: [];
	const parts = [
		property(input, 'content'),
		property(input, 'oldText'),
		property(input, 'oldString'),
		property(input, 'newText'),
		property(input, 'newString'),
		property(input, 'command'),
		property(input, 'pattern'),
		property(input, 'query'),
		property(input, 'url'),
		property(input, 'prompt')
	].reduce<ReadonlyArray<string>>((accumulator, value) => {
		const current = nonEmptyStringOption(value);
		return Option.isSome(current)
			? [...accumulator, current.value]
			: accumulator;
	}, editContent);

	return buildInput({
		filePath: getFilePath(input),
		command: anyStringOption(property(input, 'command')),
		content:
			parts.length === 0 ? none() : Option.some(parts.join('\n')),
		changedSpans: none(),
		pattern: anyStringOption(property(input, 'pattern')),
		prompt: anyStringOption(property(input, 'prompt')),
		query: anyStringOption(property(input, 'query')),
		url: anyStringOption(property(input, 'url'))
	});
};

const spanOrder = Order.mapInput(
	Order.Number,
	(replacement: ReplacementSpan) => replacement.span.start
);

/**
 * Classify why an edit set cannot be applied authoritatively. Returns the
 * sorted unique spans when every replacement resolves exactly once and no two
 * spans overlap.
 */
const resolveEdits = (
	source: string,
	replacements: ReadonlyArray<Edit.Value>
): { readonly ok: true; readonly resolved: ReadonlyArray<ReplacementSpan> } | {
	readonly ok: false;
	readonly reason: string;
} => {
	const firstFailure = replacements
		.map((replacement) => ({ replacement, resolution: Edit.resolution(replacement, source) }))
		.find(({ resolution }) => !(resolution instanceof Edit.UniqueMatch));
	if (firstFailure !== undefined) {
		const { resolution } = firstFailure;
		const reason =
			resolution instanceof Edit.EmptyOldText
				? 'empty-old-text'
				: resolution instanceof Edit.MissingMatch
					? 'missing-old-text'
					: resolution instanceof Edit.AmbiguousMatch
						? 'ambiguous-old-text'
						: 'unresolved-replacement';
		return { ok: false, reason };
	}

	const resolved = replacements.flatMap((replacement) => {
		const span = Edit.resolvedSpan(replacement, source);
		return span === undefined
			? []
			: [{ newText: replacement.newText, span } satisfies ReplacementSpan];
	});

	const sorted = sort(resolved, spanOrder);
	const hasOverlap = sorted.some((replacement, index) => {
		if (index === 0) return false;
		const previous = sorted[index - 1];
		return (
			previous !== undefined && replacement.span.start < previous.span.end
		);
	});
	if (hasOverlap) return { ok: false, reason: 'overlapping-replacements' };
	return { ok: true, resolved: sorted };
};

const applyEdits = (
	source: string,
	sorted: ReadonlyArray<ReplacementSpan>
): ProjectedContent => {
	const initialState: {
		readonly cursor: number;
		readonly output: string;
		readonly changedSpans: ReadonlyArray<Edit.Span>;
	} = { cursor: 0, output: '', changedSpans: [] };

	const rebuilt = sorted.reduce(
		(state, replacement) => {
			const unchanged = source.slice(state.cursor, replacement.span.start);
			const start = state.output.length + unchanged.length;
			const end = start + replacement.newText.length;
			return {
				cursor: replacement.span.end,
				output: state.output + unchanged + replacement.newText,
				changedSpans:
					replacement.newText.length === 0
						? state.changedSpans
						: [...state.changedSpans, new Edit.Span({ start, end })]
			};
		},
		initialState
	);
	return {
		content: `${rebuilt.output}${source.slice(rebuilt.cursor)}`,
		changedSpans: rebuilt.changedSpans
	};
};

const resolvedNewSpan = (
	replacement: Edit.Value,
	output: string
): Option.Option<Edit.Span> => {
	if (replacement.newText.length === 0) return none();
	const first = output.indexOf(replacement.newText);
	if (first === -1) return none();
	if (output.indexOf(replacement.newText, first + 1) !== -1) return none();
	return Option.some(
		new Edit.Span({ start: first, end: first + replacement.newText.length })
	);
};

const changedSpansFromFinalOutput = (
	output: string,
	replacements: ReadonlyArray<Edit.Value>
): Option.Option<ReadonlyArray<Edit.Span>> => {
	const withText = replacements.filter((r) => r.newText.length > 0);
	const spans = withText.flatMap((replacement) =>
		Option.match(resolvedNewSpan(replacement, output), {
			onNone: () => [],
			onSome: (span) => [span]
		})
	);
	return spans.length === withText.length ? Option.some(spans) : none();
};

export namespace Projection {
	export interface Interface {
		readonly raw: (input: unknown) => Effect.Effect<Input.Value>;
		readonly prospective: (
			cwd: string,
			intent: IntentValue
		) => Effect.Effect<Input.Value>;
		readonly actual: (
			cwd: string,
			intent: IntentValue
		) => Effect.Effect<Input.Value>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/Projection'
	) {}

	export const layer: Layer.Layer<
		Service,
		never,
		FileSystem.FileSystem | Path.Path
	> = Layer.effect(
		Service,
		Effect.gen(function*() {
			const fileSystem = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const readTargetFile = (
				cwd: string,
				filePath: Option.Option<string>
			): Effect.Effect<Option.Option<string>> =>
				Option.isNone(filePath)
					? Effect.succeed(none<string>())
					: normalizePath({
						cwd,
						fileSystem,
						path,
						value: filePath.value
					}).pipe(
						Effect.flatMap((normalizedPath) =>
							fileSystem.readFileString(normalizedPath).pipe(
								Effect.map(Option.some),
								Effect.catchTag('PlatformError', () =>
									Effect.succeed(none<string>())
								)
							)
						)
					);

			const raw = (input: unknown) => Effect.succeed(rawProjection(input));

			const prospectiveEdit = (
				cwd: string,
				intent: Intent.EditFile,
				filePath: Option.Option<string>
			): Effect.Effect<Input.Value> =>
				readTargetFile(cwd, filePath).pipe(Effect.flatMap((source) => {
					if (Option.isNone(source)) {
						return Effect.succeed(
							withFile(filePath, none(), none(), 'target-file-missing')
						);
					}
					const outcome = resolveEdits(source.value, intent.replacements);
					if (!outcome.ok) {
						return Effect.succeed(
							withFile(filePath, none(), none(), outcome.reason)
						);
					}
					const projected = applyEdits(source.value, outcome.resolved);
					return Effect.succeed(
						withFile(
							filePath,
							Option.some(projected.content),
							Option.some(projected.changedSpans)
						)
					);
				}));

			const prospective: Interface['prospective'] = (cwd, intent) => {
				const filePath = stringOption(intent.filePath);
				if (intent instanceof Intent.WriteFile) {
					return Effect.succeed(
						withFile(
							filePath,
							Option.some(intent.content),
							Option.some(fullChangedSpan(intent.content))
						)
					);
				}
				return prospectiveEdit(cwd, intent, filePath);
			};

			const actual: Interface['actual'] = (cwd, intent) => {
				const filePath = stringOption(intent.filePath);
				return readTargetFile(cwd, filePath).pipe(
					Effect.flatMap((content) => {
						if (Option.isNone(content)) return prospective(cwd, intent);
						if (intent instanceof Intent.WriteFile) {
							return Effect.succeed(
								withFile(filePath, content, Option.some(fullChangedSpan(content.value)))
							);
						}
						return Effect.succeed(
							withFile(
								filePath,
								content,
								changedSpansFromFinalOutput(content.value, intent.replacements)
							)
						);
					})
				);
			};

			return Service.of({ raw, prospective, actual });
		})
	);
}
