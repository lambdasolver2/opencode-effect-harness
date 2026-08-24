import { Lang, parse } from '@ast-grep/napi';
import type { NapiConfig, Rule as AstGrepRuleDefinition } from '@ast-grep/napi';
import picomatch from 'picomatch';
import { Context, Effect, Layer, Option } from 'effect';

import { Input } from './Input.ts';
import { Pattern } from './Pattern.ts';

const regexOption = Option.liftThrowable((pattern: string) => new RegExp(pattern));
const globOption = Option.liftThrowable((glob: string) => picomatch(glob));
const astRoot = Option.liftThrowable((lang: Lang, source: string) =>
	parse(lang, source).root()
);

const values = (projection: Input.Value) =>
	[
		projection.command,
		projection.content,
		projection.pattern,
		projection.query,
		projection.url,
		projection.prompt
	].flatMap((value) =>
		Option.match(value, {
			onNone: () => [],
			onSome: (current) => [current]
		})
	);

/**
 * stripComments — pure state-machine reducer over code points. Emits exactly
 * one output char per input char (comment chars become spaces; newlines are
 * preserved) so match indices in the stripped text map 1:1 onto the original
 * source spans. Strings and templates (incl. escapes) are kept verbatim.
 */
type ScanState =
	| { readonly tag: 'code'; readonly pendingSlash: boolean }
	| { readonly tag: 'line' }
	| { readonly tag: 'block'; readonly star: boolean }
	| { readonly tag: 'quoted'; readonly quote: string; readonly escaped: boolean };

interface ScanAcc {
	readonly out: Array<string>;
	readonly state: ScanState;
}

const blankChar = (ch: string): string => (ch === '\n' ? '\n' : ' ');

const step = (acc: ScanAcc, ch: string): ScanAcc => {
	const keep = () => [...acc.out, ch];
	const blank = () => [...acc.out, blankChar(ch)];

	switch (acc.state.tag) {
		case 'code': {
			if (acc.state.pendingSlash) {
				if (ch === '/') return { out: [...acc.out, ' ', ' '], state: { tag: 'line' } };
				if (ch === '*') return { out: [...acc.out, ' ', ' '], state: { tag: 'block', star: false } };
				return {
					out: [...acc.out, '/', ...(ch === '/' ? [] : [ch])],
					state:
						ch === '/'
							? acc.state
							: { tag: 'code', pendingSlash: false }
				};
			}
			if (ch === "'") return { out: keep(), state: { tag: 'quoted', quote: "'", escaped: false } };
			if (ch === '"') return { out: keep(), state: { tag: 'quoted', quote: '"', escaped: false } };
			if (ch === '`') return { out: keep(), state: { tag: 'quoted', quote: '`', escaped: false } };
			if (ch === '/') return { out: acc.out, state: { tag: 'code', pendingSlash: true } };
			return { out: keep(), state: acc.state };
		}
		case 'line':
			return ch === '\n'
				? { out: keep(), state: { tag: 'code', pendingSlash: false } }
				: { out: blank(), state: acc.state };
		case 'block': {
			if (acc.state.star && ch === '/') return { out: blank(), state: { tag: 'code', pendingSlash: false } };
			return { out: blank(), state: { tag: 'block', star: ch === '*' } };
		}
		case 'quoted': {
			if (acc.state.escaped) {
				return { out: keep(), state: { ...acc.state, escaped: false } };
			}
			if (ch === '\\') return { out: keep(), state: { ...acc.state, escaped: true } };
			if (ch === acc.state.quote) {
				return { out: keep(), state: { tag: 'code', pendingSlash: false } };
			}
			return { out: keep(), state: acc.state };
		}
	}
};

export const stripComments = (source: string): string => {
	const chars = [...source];
	const final = chars.reduce<ScanAcc>(step, {
		out: [],
		state: { tag: 'code', pendingSlash: false }
	});
	const tail = final.state.tag === 'code' && final.state.pendingSlash ? ['/'] : [];
	return [...final.out, ...tail].join('');
};

const toolMatches = (pattern: Pattern.Value, toolName: string): boolean =>
	Option.match(regexOption(pattern.toolRegex), {
		onNone: () => false,
		onSome: (regex) => regex.test(toolName)
	});

const pathMatchesGlob = (glob: string, value: string): boolean =>
	Option.match(globOption(glob), {
		onNone: () => false,
		onSome: (matcher) => matcher(value)
	});

const filePathOf = (projection: Input.Value) => projection.filePath;

const globMatches = (
	pattern: Pattern.Value,
	projection: Input.Value
): boolean => {
	const glob = pattern.glob;
	if (glob === undefined) return true;
	return Option.match(filePathOf(projection), {
		onNone: () => false,
		onSome: (value) => pathMatchesGlob(glob, value)
	});
};

const ignoreGlobMatches = (
	pattern: Pattern.Value,
	projection: Input.Value
): boolean =>
	pattern.ignoreGlob === undefined
		? false
		: Option.match(filePathOf(projection), {
			onNone: () => false,
			onSome: (value) =>
				pattern.ignoreGlob?.some((glob) => pathMatchesGlob(glob, value)) ??
					false
		});

const globalRegex = (regex: RegExp): RegExp =>
	new RegExp(
		regex.source,
		regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
	);

const locationFromSpan = (
	source: string,
	start: number,
	end: number
): Pattern.MatchLocation => {
	const before = source.slice(0, start);
	const line = before.split('\n').length;
	const previousLineBreak = before.lastIndexOf('\n');
	const lineStart = previousLineBreak === -1 ? 0 : previousLineBreak + 1;
	const snippet = source.slice(start, end).split('\n')[0] ?? '';
	return new Pattern.MatchLocation({
		start,
		end,
		line,
		column: start - lineStart + 1,
		snippet: snippet.trim()
	});
};

const regexMatchLocations = (
	pattern: Pattern.RegexDetector,
	source: string,
	originalSource: string
): ReadonlyArray<Pattern.MatchLocation> =>
	Option.match(regexOption(pattern.pattern), {
		onNone: () => [],
		onSome: (regex) =>
			[...source.matchAll(globalRegex(regex))].flatMap((match) => {
				if (typeof match.index !== 'number' || match[0].length === 0) return [];
				return [
					locationFromSpan(
						originalSource,
						match.index,
						match.index + match[0].length
					)
				];
			})
	});

const langFromPath = (value: string): Option.Option<Lang> =>
	value.endsWith('.tsx')
		? Option.some(Lang.Tsx)
		: value.endsWith('.ts')
			? Option.some(Lang.TypeScript)
			: value.endsWith('.jsx')
				? Option.some(Lang.Tsx)
				: value.endsWith('.js')
					? Option.some(Lang.JavaScript)
					: Option.none();

type AstRoot = ReturnType<ReturnType<typeof parse>['root']>;
type AstMatcher = string | NapiConfig;

const astFindAll = Option.liftThrowable((root: AstRoot, matcher: AstMatcher) =>
	root.findAll(matcher)
);

const astMatcherLocations = (
	root: AstRoot,
	matcher: AstMatcher,
	source: string
): ReadonlyArray<Pattern.MatchLocation> =>
	Option.match(astFindAll(root, matcher), {
		onNone: () => [],
		onSome: (nodes) =>
			nodes.map((node) =>
				locationFromSpan(
					source,
					node.range().start.index,
					node.range().end.index
				)
			)
	});

const astRuleMatcher = (
	pattern: Pattern.AstDetector,
	rule: AstGrepRuleDefinition
): NapiConfig =>
	pattern.constraints === undefined
		? { rule }
		: { rule, constraints: pattern.constraints };

// A detector matches if ANY of its patterns matches.
const legacyAstMatcher = (
	pattern: Pattern.AstDetector,
	candidate: string
): AstMatcher =>
	pattern.inside === undefined
		? candidate
		: {
			rule: {
				pattern: candidate,
				inside: { pattern: pattern.inside, stopBy: 'end' }
			}
		};

const astMatchLocationsForRoot = (
	root: AstRoot,
	pattern: Pattern.AstDetector,
	source: string
): ReadonlyArray<Pattern.MatchLocation> => [
	...pattern.patterns.flatMap((candidate) =>
		astMatcherLocations(root, legacyAstMatcher(pattern, candidate), source)
	),
	...(pattern.rules ?? []).flatMap((rule) =>
		astMatcherLocations(root, astRuleMatcher(pattern, rule), source)
	)
];

const astMatchLocations = (
	pattern: Pattern.AstDetector,
	source: string,
	projection: Input.Value
): ReadonlyArray<Pattern.MatchLocation> =>
	Option.match(filePathOf(projection), {
		onNone: () => [],
		onSome: (value) =>
			Option.match(langFromPath(value), {
				onNone: () => [],
				onSome: (lang) =>
					Option.match(astRoot(lang, source), {
						onNone: () => [],
						onSome: (root) =>
							astMatchLocationsForRoot(root, pattern, source)
					})
			})
	});

const spansIntersect = (
	left: { readonly start: number; readonly end: number },
	right: { readonly start: number; readonly end: number }
): boolean => left.start < right.end && right.start < left.end;

const filterToChangedSpans = (
	projection: Input.Value,
	locations: ReadonlyArray<Pattern.MatchLocation>
): ReadonlyArray<Pattern.MatchLocation> =>
	Option.match(projection.changedSpans, {
		onNone: () => locations,
		onSome: (changedSpans) =>
			locations.filter((location) =>
				changedSpans.some((span) => spansIntersect(location, span))
			)
	});

export const findPatternMatches = (
	toolName: string,
	projection: Input.Value,
	eventType: 'before' | 'after',
	pattern: Pattern.Value
): ReadonlyArray<Pattern.MatchLocation> => {
	const content = Option.getOrElse(projection.content, () => '');
	if (
		pattern.event !== eventType ||
		!toolMatches(pattern, toolName) ||
		!globMatches(pattern, projection) ||
		ignoreGlobMatches(pattern, projection)
	) {
		return [];
	}

	const locations =
		pattern.detector instanceof Pattern.AstDetector
			? astMatchLocations(pattern.detector, content, projection)
			: regexMatchLocations(
				pattern.detector,
				pattern.detector.matchInComments ? content : stripComments(content),
				content
			);
	return filterToChangedSpans(projection, locations);
};

export const matchesPattern = (
	toolName: string,
	projection: Input.Value,
	eventType: 'before' | 'after',
	pattern: Pattern.Value
): boolean =>
	findPatternMatches(toolName, projection, eventType, pattern).length > 0;

export namespace Matcher {
	export interface Interface {
		readonly matches: (
			toolName: string,
			projection: Input.Value,
			eventType: 'before' | 'after',
			pattern: Pattern.Value
		) => Effect.Effect<boolean>;
		readonly findMatches: (
			toolName: string,
			projection: Input.Value,
			eventType: 'before' | 'after',
			pattern: Pattern.Value
		) => Effect.Effect<ReadonlyArray<Pattern.MatchLocation>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/enforcement/Matcher'
	) {}

	export const layer: Layer.Layer<Service> = Layer.succeed(
		Service,
		Service.of({
			matches: (toolName, projection, eventType, pattern) =>
				Effect.succeed(matchesPattern(toolName, projection, eventType, pattern)),
			findMatches: (toolName, projection, eventType, pattern) =>
				Effect.succeed(
					findPatternMatches(toolName, projection, eventType, pattern)
				)
		})
	);
}
