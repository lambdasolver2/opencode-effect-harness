import { Schema } from 'effect';

import { Edit } from './Edit.ts';

export namespace Intent {
	/** Kernel-neutral write phases. Host adapters map tool hooks onto these. */
	export const Phase = Schema.Literals(['before', 'after'] as const);

	export class WriteFile extends Schema.TaggedClass<WriteFile>()(
		'WriteFile',
		{
			phase: Phase,
			filePath: Schema.optionalKey(Schema.String),
			content: Schema.String
		}
	) {}

	export class EditFile extends Schema.TaggedClass<EditFile>()(
		'EditFile',
		{
			phase: Phase,
			filePath: Schema.optionalKey(Schema.String),
			replacements: Schema.Array(Edit.Value)
		}
	) {}

	export const Value = Schema.Union([WriteFile, EditFile]);
}

export namespace Intent {
	/** Raw content view: write content, or joined newTexts of edits. */
	export const contentRaw = (intent: WriteFile | EditFile): string => {
		const parts =
			intent instanceof Intent.WriteFile
				? [intent.content]
				: intent.replacements.flatMap((r) =>
					r.newText.length > 0 ? [r.newText] : []
				);
		return parts.join('\n');
	};
}

import { make } from 'effect/unstable/reactivity/Atom';

export namespace IntentAtoms {
	export const contentRaw = (intent: Intent.WriteFile | Intent.EditFile) =>
		make(Intent.contentRaw(intent));
}
