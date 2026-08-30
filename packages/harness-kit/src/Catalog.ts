import type { Rule as AstGrepRuleDefinition } from '@ast-grep/napi';
import { Context, Effect, FileSystem, Layer, Option, Order, Path, Schema } from 'effect';
import { sort } from 'effect/Array';
import YAML from 'yaml';

import { SKIPPED_FILES } from './Constants.ts';
import { Pattern } from './Pattern.ts';
import { RuleDefinition } from './rule/Definition.ts';

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

const isAlreadyQuoted = (val: string): boolean =>
	(val.startsWith("'") && val.endsWith("'")) ||
	(val.startsWith('"') && val.endsWith('"'));

/** Safe values contain only word chars, space, hyphen, dot, underscore, slash. */
const SAFE_VALUE_RE = /^[\w\s.\-/]+$/;

const quoteYamlValue = (line: string): string => {
	const m = line.match(/^(\s*)(\w[\w-]*):\s+(.+)$/);
	if (!m) return line;
	const [, indent, key, val] = m as [string, string, string, string];
	if (isAlreadyQuoted(val) || SAFE_VALUE_RE.test(val)) return line;
	const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `${indent}${key}: "${escaped}"`;
};

export const parseFrontmatter = (content: string): Record<string, unknown> => {
	const match = content.match(FRONTMATTER_RE);
	if (!match?.[1]) return {};
	try {
		const sanitized = match[1].split('\n').map(quoteYamlValue).join('\n');
		const parsed: unknown = YAML.parse(sanitized);
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

export const extractBody = (content: string): string =>
	content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

// ---------------------------------------------------------------------------
// Pattern catalog — strict: a malformed REQUIRED asset is a typed error,
// never a silently smaller catalog.
// ---------------------------------------------------------------------------

export class CatalogError extends Schema.TaggedError<CatalogError>()(
	'CatalogError',
	{
		path: Schema.String,
		reason: Schema.String
	}
) {}

type PatternLevel = Schema.Schema.Type<typeof RuleDefinition.Severity>;

const regexOption = Option.liftThrowable((pattern: string) => new RegExp(pattern));
const emptyEntries: ReadonlyArray<string> = [];

const readStringArray = (value: unknown): Option.Option<ReadonlyArray<string>> => {
	if (!Array.isArray(value)) return Option.none();
	const strings = value.flatMap((entry) =>
		typeof entry === 'string' ? [entry] : []
	);
	return strings.length === value.length
		? Option.some(strings)
		: Option.none();
};

const stringOption = (value: unknown): Option.Option<string> =>
	typeof value === 'string' ? Option.some(value) : Option.none();

const isAstGrepRuleDefinition = (
	value: unknown
): value is AstGrepRuleDefinition => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0) return false;
	return keys.some((k) =>
		['pattern', 'regex', 'kind', 'any', 'all', 'not', 'inside', 'constraints'].includes(k)
	);
};

const readAstRuleList = (
	value: unknown
): Option.Option<ReadonlyArray<AstGrepRuleDefinition>> => {
	if (isAstGrepRuleDefinition(value)) return Option.some([value]);
	if (!Array.isArray(value)) return Option.none();
	const rules = value.flatMap((entry) =>
		isAstGrepRuleDefinition(entry) ? [entry] : []
	);
	return rules.length === value.length && rules.length > 0
		? Option.some(rules)
		: Option.none();
};

const readAstRuleRecord = (
	value: unknown
): Option.Option<Record<string, AstGrepRuleDefinition>> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return Option.none();
	}
	const entries = Object.entries(value);
	const rules = entries.flatMap(([key, entry]) =>
		isAstGrepRuleDefinition(entry) ? [[key, entry] as const] : []
	);
	return rules.length === entries.length
		? Option.some(Object.fromEntries(rules))
		: Option.none();
};

const isSkippedFile = (name: string): boolean =>
	SKIPPED_FILES.some(
		(prefix) =>
			name.toLowerCase().startsWith(prefix.toLowerCase()) ||
			name.toLowerCase() === `${prefix.toLowerCase()}.md`
	);

const levelWithDefault = (value: Option.Option<string>): Option.Option<PatternLevel> =>
	Option.match(value, {
		onNone: () => Option.some('info' as PatternLevel),
		onSome: (current) =>
			current === 'critical' ||
			current === 'high' ||
			current === 'medium' ||
			current === 'warning' ||
			current === 'info'
				? Option.some(current)
				: Option.none()
	});

const eventWithDefault = (value: Option.Option<string>): Option.Option<'before' | 'after'> =>
	Option.match(value, {
		onNone: () => Option.some('before' as const),
		onSome: (current) => {
			const lower = current.toLowerCase();
			return lower === 'before' || lower === 'after' ? Option.some(lower) : Option.none();
		}
	});

const readPatternList = (
	raw: unknown
): Option.Option<ReadonlyArray<string>> => {
	if (typeof raw === 'string') return Option.some([raw]);
	return readStringArray(raw);
};

export const toDetector = (
	raw: Record<string, unknown>
): Option.Option<Pattern.RegexDetector | Pattern.AstDetector> => {
	const detectorOpt = stringOption(raw.detector);
	if (Option.isNone(detectorOpt)) return Option.none();
	const rawDetector = detectorOpt.value;
	if (rawDetector !== 'ast' && rawDetector !== 'regex') return Option.none();
	const detector = rawDetector;

	if (detector === 'ast') {
		const rule = readAstRuleList(raw.rule);
		const rules = Option.isSome(rule) ? rule : readAstRuleList(raw.rules);
		if (Option.isSome(rules)) {
			const constraints = readAstRuleRecord(raw.constraints);
			return Option.some(
				new Pattern.AstDetector({
					patterns: [],
					rules: [...rules.value],
					...(Option.isSome(constraints)
						? { constraints: constraints.value }
						: undefined)
				})
			);
		}

		const patterns = readPatternList(raw.pattern);
		if (Option.isNone(patterns) || patterns.value.length === 0) {
			return Option.none();
		}
		const inside = stringOption(raw.inside);
		return Option.some(
			new Pattern.AstDetector({
				patterns: patterns.value,
				...(Option.isSome(inside) ? { inside: inside.value } : undefined)
			})
		);
	}

	const pattern = stringOption(raw.pattern);
	if (Option.isNone(pattern)) return Option.none();
	return Option.isSome(regexOption(pattern.value))
		? Option.some(
			new Pattern.RegexDetector({
				pattern: pattern.value,
				matchInComments:
					raw.matchInComments === true || raw.matchInComments === 'true'
			})
		)
		: Option.none();
};

const toPattern = (
	filePath: string,
	content: string
): Option.Option<Pattern.Value> => {
	const raw = parseFrontmatter(content);
	const name = stringOption(raw.name);
	const detector = toDetector(raw);
	const toolRegex = Option.match(stringOption(raw.tool), {
		onNone: () => '.*',
		onSome: (value) => value
	});
	const levelOpt = levelWithDefault(stringOption(raw.level));
	const eventOpt = eventWithDefault(stringOption(raw.event));
	if (
		Option.isNone(name) ||
		Option.isNone(detector) ||
		Option.isNone(levelOpt) ||
		Option.isNone(eventOpt) ||
		Option.isNone(regexOption(toolRegex))
	) {
		return Option.none();
	}

	const description = Option.match(stringOption(raw.description), {
		onNone: () => '',
		onSome: (value) => value
	});
	const glob = stringOption(raw.glob);
	const ignoreGlob = readStringArray(raw.ignoreGlob);
	const suggestedSkills = readStringArray(raw.suggestSkills);
	return Option.some(
		new Pattern.Value({
			name: name.value,
			description,
			event: eventOpt.value,
			toolRegex,
			level: levelOpt.value,
			...(Option.isSome(glob) ? { glob: glob.value } : undefined),
			...(Option.isSome(ignoreGlob)
				? { ignoreGlob: [...ignoreGlob.value] }
				: undefined),
			detector: detector.value,
			guidance: extractBody(content),
			...(Option.isSome(suggestedSkills)
				? { suggestedSkills: [...suggestedSkills.value] }
				: undefined),
			sourcePath: filePath
		})
	);
};

const patternOrder = Order.mapInput(
	Order.String,
	(pattern: Pattern.Value) => pattern.sourcePath
);

export const toRuleDefinition = (pattern: Pattern.Value) =>
	new RuleDefinition.Definition({
		id: `legacy-pattern:${pattern.name}`,
		description: pattern.description,
		action: 'injectUserMessage',
		severity: pattern.level,
		patternName: pattern.name,
		sourcePath: pattern.sourcePath
	});

/**
 * Load every pattern under `patternsDir`. Missing directory or unreadable/
 * malformed detector files are `CatalogError` failures — the catalog must be
 * complete or explicitly broken; a partial catalog is never silently accepted.
 */
export const loadPatterns = (patternsDir: string) =>
	Effect.gen(function*() {
		const fileSystem = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const stat = (target: string) =>
			fileSystem.stat(target).pipe(
				Effect.map(Option.some),
				Effect.catchTag('PlatformError', () =>
					Effect.succeed(Option.none<FileSystem.File.Info>())
				)
			);

		const walkPatterns = (
			directory: string
		): Effect.Effect<ReadonlyArray<Pattern.Value>, CatalogError> =>
			Effect.gen(function*() {
				const entries = yield* fileSystem.readDirectory(directory).pipe(
					Effect.catchTag('PlatformError', () =>
						Effect.fail(
							new CatalogError({
								path: directory,
								reason: 'cannot read patterns directory'
							})
						)
					)
				);
				const nested = yield* Effect.forEach(
					entries,
					(entry) =>
						Effect.gen(function*() {
							const fullPath = path.join(directory, entry);
							const info = yield* stat(fullPath);
							if (Option.isNone(info)) {
								return yield* Effect.fail(
									new CatalogError({ path: fullPath, reason: 'unreadable entry' })
								);
							}
							if (info.value.type === 'Directory') {
								return yield* walkPatterns(fullPath);
							}
							if (
								info.value.type !== 'File' ||
								!entry.endsWith('.md') ||
								isSkippedFile(entry)
							) {
								return [];
							}
							const content = yield* fileSystem.readFileString(fullPath).pipe(
								Effect.catchTag('PlatformError', () =>
									Effect.fail(
										new CatalogError({ path: fullPath, reason: 'unreadable file' })
									)
								)
							);
							const parsed = toPattern(fullPath, content);
							if (Option.isNone(parsed)) {
								return yield* Effect.fail(
									new CatalogError({
										path: fullPath,
										reason: 'malformed pattern frontmatter/detector'
									})
								);
							}
							return [parsed.value];
						}),
					{ concurrency: 8 }
				);
				return nested.flatMap((patterns) => [...patterns]);
			});

		return sort(yield* walkPatterns(patternsDir), patternOrder);
	});

export namespace Catalog {
	export interface Interface {
		readonly getPatterns: Effect.Effect<
			ReadonlyArray<Pattern.Value>,
			CatalogError
		>;
		readonly getRules: Effect.Effect<
			ReadonlyArray<RuleDefinition.Definition>,
			CatalogError
		>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/PatternCatalog'
	) {}

	export const layer = (patternsDir: string) =>
		Layer.effect(
			Service,
			Effect.gen(function*() {
				const patterns = yield* loadPatterns(patternsDir);
				return Service.of({
					getPatterns: Effect.succeed(patterns),
					getRules: Effect.succeed(patterns.map(toRuleDefinition))
				});
			})
		);
}
