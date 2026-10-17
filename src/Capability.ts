/**
 * Capability — native skill registration behind an explicit capability probe
 * (spec A2 / AUDIT-042). Candidate skill payloads are validated against the
 * PINNED host schema (`@opencode/schema/skill`) so branded ids/names are
 * produced by the SDK's own decoder instead of `as never` casts. Invalid or
 * unsupported registrations are COUNTED AND REPORTED — never silent.
 */
import { Effect, Schema } from 'effect';
import { Skill as SkillSchema } from '@opencode/schema/skill';

export interface PreparedSkillInfo {
	readonly id: unknown;
	readonly name: unknown;
	readonly path: unknown;
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

/**
 * Tool-usage protocol appended to EVERY registered skill body at
 * registration time (asset files stay untouched, fingerprints intact).
 * This is what teaches the model exactly when — and how often — to call
 * each harness tool. Loaded skill content enters the conversation, so the
 * model reads this right after the domain guidance.
 */
export const HARNESS_TOOL_PROTOCOL = [
	'## Harness tools — when and how often',
	'',
	'Keyword mention alone never triggers a tool — mentioning `effect`, `adversary`/`adversarial`, `critic`, or `verify` in chat loads knowledge only, it does NOT authorize a call.',
	'',
	'- `effect_harness_verify` {touchedFiles}: only after this response actually wrote/edited/patched Effect/TypeScript code (batch all touched files into that one call, not one call per file), and once more before claiming done, pushing, or opening a PR for such changes. Do NOT call on question-only, discussion-only, or planning-only turns with no file writes.',
	'- `effect_harness_critic` {summary >= 10 chars, focus}: only after actually finishing a feature, plan item, or architecture decision in this session, or on explicit user request for an adversary/critic review — never per edit, never in a loop, never on keyword mention alone.',
	'- `harness_skill_stats`: only when you are unsure which effect-* skills are already loaded. Rarely needed.',
	'- `harness_toggle`: only on explicit user request. Never call autonomously.',
	'- `effect_harness_compound`: only on explicit user benchmark request. Never auto-run.'
].join('\n');

export interface PreparationResult {
	readonly infos: ReadonlyArray<PreparedSkillInfo>;
	/** Candidates rejected by the pinned host schema. */
	readonly rejected: number;
}

const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---/;
const DESCRIPTION_LINE = /(^|\n)description:\s*([^\n]+)/;

interface CandidateInfo {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly description: string;
	readonly content: string;
}

const buildCandidate = (
	entry: MinimalEntry,
	content: string
): CandidateInfo => ({
	id: entry.name,
	name: entry.name,
	path: entry.skillFilePath,
	description:
		content.match(FRONTMATTER_BLOCK)?.[1]?.match(DESCRIPTION_LINE)?.[2]?.trim() ??
		`Effect v4 skill: ${entry.name}`,
	content
});

/** Decode through the SDK schema; branded fields are produced here or not at all. */
const decodeCandidate = (candidate: CandidateInfo): unknown => {
	try {
		return Schema.decodeUnknownSync(SkillSchema.Info)(candidate);
	} catch {
		return undefined;
	}
};

/** Async preparation of all skill payloads (files load BEFORE transform). */
export interface MinimalEntry {
	readonly name: string;
	readonly skillFilePath: string;
}

export const prepareAll = (
	entries: ReadonlyArray<MinimalEntry>,
	loadContent: (entry: MinimalEntry) => Effect.Effect<string>
): Effect.Effect<PreparationResult> =>
	Effect.forEach(
		entries,
		(entry) =>
			Effect.map(loadContent(entry), (content) => ({ entry, content })),
		{ concurrency: 8 }
	).pipe(
		Effect.map((loaded) => {
			let rejected = 0;
			const infos = loaded.flatMap(({ entry, content }) => {
				const candidate = buildCandidate(entry, content);
				const decoded = decodeCandidate(candidate);
				if (decoded === undefined) {
					rejected += 1;
					return [];
				}
				const info = decoded as Schema.Schema.Type<typeof SkillSchema.Info>;
				return [
					{
						id: info.id,
						name: info.name,
						path: info.path,
						description: candidate.description,
						content,
						kernelName: entry.name
					}
				];
			});
			return { infos, rejected };
		})
	);

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
			path: info.path,
			description: info.description,
			content: `${info.content}\n\n${HARNESS_TOOL_PROTOCOL}`
		})
	);
	return { attempted: true, registered: infos.length };
};
