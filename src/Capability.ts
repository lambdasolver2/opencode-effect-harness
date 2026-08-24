/**
 * Capability — native skill registration behind an explicit capability probe
 * (spec A2). Host `SkillDraft` shapes are inspected at runtime; when `add` is
 * unsupported the result SAYS so instead of failing silently. Branded host
 * fields cross ONE localized conversion helper with validated strings.
 */
import { Effect } from 'effect';

export interface PreparedSkillInfo {
	readonly id: unknown;
	readonly name: unknown;
	readonly location: unknown;
	readonly description: string;
	readonly content: string;
	readonly kernelName: string;
}

export interface SkillDraftProbe {
	add?: ((skill: unknown) => void) | undefined;
	list?: (() => ReadonlyArray<unknown>) | undefined;
}

export interface RegistrationResult {
	readonly attempted: boolean;
	readonly registered: number;
	readonly reason?: string | undefined;
}

const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---/;
const DESCRIPTION_LINE = /(^|\n)description:\s*([^\n]+)/;

/** Localized branded conversion — one boundary, validated inputs (A2/A42). */
export const prepareInfo = (input: {
	readonly entry: MinimalEntry;
	readonly content: string;
	readonly idBrand: (value: string) => unknown;
	readonly nameBrand: (value: string) => unknown;
	readonly pathBrand: (value: string) => unknown;
}): PreparedSkillInfo => ({
	kernelName: input.entry.name,
	id: input.idBrand(input.entry.name),
	name: input.nameBrand(input.entry.name),
	location: input.pathBrand(input.entry.skillFilePath),
	description:
		input.content.match(FRONTMATTER_BLOCK)?.[1]?.match(DESCRIPTION_LINE)?.[2]?.trim() ??
		`Effect v4 skill: ${input.entry.name}`,
	content: input.content
});

/**
 * Probe-and-apply synchronously inside the transform callback. Unsupported
 * drafts produce a structured result — a documented release decision, never a
 * hidden error (audit A2).
 */
export const applyToDraft = (
	draft: SkillDraftProbe,
	infos: ReadonlyArray<PreparedSkillInfo>
): RegistrationResult => {
	if (typeof draft.add !== 'function') {
		return {
			attempted: false,
			registered: 0,
			reason:
				'skill.transform draft exposes no supported add operation on this pinned version'
		};
	}
	const add = draft.add;
	infos.forEach((info) =>
		add({
			id: info.id,
			name: info.name,
			location: info.location,
			description: info.description,
			content: info.content
		})
	);
	return { attempted: true, registered: infos.length };
};

/** Async preparation of all skill payloads (file loading happens BEFORE transform). */
export interface MinimalEntry {
	readonly name: string;
	readonly skillFilePath: string;
}

export const prepareAll = (
	entries: ReadonlyArray<MinimalEntry>,
	loadContent: (entry: MinimalEntry) => Effect.Effect<string>,
	brands: {
		readonly idBrand: (value: string) => unknown;
		readonly nameBrand: (value: string) => unknown;
		readonly pathBrand: (value: string) => unknown;
	}
): Effect.Effect<ReadonlyArray<PreparedSkillInfo>> =>
	Effect.forEach(
		entries,
		(entry) =>
			Effect.orElseSucceed(
				Effect.map(loadContent(entry), (content) => prepareInfo({ entry, content, ...brands })),
				() => undefined
			),
		{ concurrency: 8 }
	).pipe(Effect.map((list) => list.flatMap((i) => (i !== undefined ? [i] : []))));
