import { Schema } from 'effect';

export namespace Edit {
	export class Span extends Schema.Class<Span>('EditReplacementSpan')({
		start: Schema.Number,
		end: Schema.Number
	}) {}

	export class Value extends Schema.Class<Value>('EditReplacement')({
		oldText: Schema.String,
		newText: Schema.String
	}) {}

	export class UniqueMatch extends Schema.TaggedClass<UniqueMatch>()(
		'UniqueMatch',
		{
			span: Span
		}
	) {}

	export class MissingMatch extends Schema.TaggedClass<MissingMatch>()(
		'MissingMatch',
		{}
	) {}

	export class AmbiguousMatch extends Schema.TaggedClass<AmbiguousMatch>()(
		'AmbiguousMatch',
		{
			occurrenceCount: Schema.Number
		}
	) {}

	export class OverlappingMatch extends Schema.TaggedClass<OverlappingMatch>()(
		'OverlappingMatch',
		{}
	) {}

	export class EmptyOldText extends Schema.TaggedClass<EmptyOldText>()(
		'EmptyOldText',
		{}
	) {}

	export const Resolution = Schema.Union([
		UniqueMatch,
		MissingMatch,
		AmbiguousMatch,
		OverlappingMatch,
		EmptyOldText
	]);
}

export namespace Edit {
	export const occurrenceCount = (replacement: Value, source: string): number =>
		replacement.oldText.length === 0
			? 0
			: source.split(replacement.oldText).length - 1;

	export const resolution = (
		replacement: Value,
		source: string
	): UniqueMatch | MissingMatch | AmbiguousMatch | OverlappingMatch | EmptyOldText => {
		if (replacement.oldText.length === 0) return new EmptyOldText({});
		const count = occurrenceCount(replacement, source);
		if (count === 0) return new MissingMatch({});
		if (count > 1) return new AmbiguousMatch({ occurrenceCount: count });
		const start = source.indexOf(replacement.oldText);
		return new UniqueMatch({
			span: new Span({ start, end: start + replacement.oldText.length })
		});
	};

	export const resolvedSpan = (
		replacement: Value,
		source: string
	): Span | undefined => {
		const current = resolution(replacement, source);
		return current instanceof UniqueMatch ? current.span : undefined;
	};

	export const isApplicable = (replacement: Value, source: string): boolean =>
		resolution(replacement, source) instanceof UniqueMatch;
}

import { make } from 'effect/unstable/reactivity/Atom';

export namespace EditAtoms {
	export const resolution = (replacement: Edit.Value, source: string) =>
		make(Edit.resolution(replacement, source));
	export const isApplicable = (replacement: Edit.Value, source: string) =>
		make(Edit.isApplicable(replacement, source));
}
