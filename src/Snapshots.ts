/**
 * Snapshots — pre-write file captures with diff-based changed-span computation.
 *
 * In execute.before, the plugin reads the target file's current content and
 * stores it as a snapshot keyed by tool-call ID. In execute.after, the final
 * content is read from disk and compared against the snapshot using
 * `diffLines` to compute exact added-text spans.
 *
 * This replaces the fragile approach of reconstructing prospective content
 * from edit replacement text — the enforcer's approach is simpler and more
 * robust because it works on real before/after data.
 */
import { diffLines } from 'diff'

export interface FileSnapshot {
	readonly absolutePath: string
	readonly filePath: string
	readonly beforeContent?: string | undefined
}

export interface ChangedSpan {
	readonly start: number
	readonly end: number
}

/** Compute half-open spans occupied by text added between before and after. */
export function computeChangedSpans(
	before: string | undefined,
	after: string
): ReadonlyArray<ChangedSpan> {
	if (before === undefined) return [{ start: 0, end: after.length }]
	const spans: Array<ChangedSpan> = []
	let cursor = 0
	for (const change of diffLines(before, after)) {
		if (change.added === true) {
			spans.push({ start: cursor, end: cursor + change.value.length })
			cursor += change.value.length
			continue
		}
		if (change.removed !== true) cursor += change.value.length
	}
	return spans
}

/** Extract affected file paths from patch text (apply_patch / patch tools). */
export function extractPatchPaths(patchText: string): ReadonlyArray<string> {
	const paths: Array<string> = []
	for (const line of patchText.split('\n')) {
		const add = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line)
		if (add?.[1] !== undefined) paths.push(add[1])
		const move = /^\*\*\* Move to: (.+)$/.exec(line)
		if (move?.[1] !== undefined) paths.push(move[1])
	}
	return [...new Set(paths)]
}

/** Extract file paths a mutating tool will affect. */
export function extractAffectedPaths(toolName: string, input: unknown): ReadonlyArray<string> {
	const props = input !== null && typeof input === 'object' ? input : {}
	const get = (key: string) => Reflect.get(props, key)

	if (toolName === 'write' || toolName === 'edit' || toolName === 'multiedit') {
		const p = get('path') ?? get('filePath') ?? get('file')
		return typeof p === 'string' ? [p] : []
	}
	if (toolName === 'apply_patch' || toolName === 'patch') {
		const text = get('patchText') ?? get('patch')
		return typeof text === 'string' ? extractPatchPaths(text) : []
	}
	return []
}

/** Read a file's content without throwing; returns undefined on failure. */
export async function readFileOrUndefined(path: string): Promise<string | undefined> {
	try {
		const { readFile } = await import('node:fs/promises')
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}
