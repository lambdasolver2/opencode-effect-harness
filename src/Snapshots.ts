/**
 * Snapshots — pre-write file captures with diff-based changed-span computation.
 *
 * execute.before stores the target file's current content keyed by tool-call
 * ID. execute.after reads the final content and derives exact added-text spans
 * with `diffLines`, feeding them into the kernel feedback rule as the ACTUAL
 * projection (no speculative reconstruction, no full-file re-scan).
 *
 * All helpers are pure; every collection transform uses combinators (no
 * imperative loops) per the repository's own catalog rules.
 */
import { diffLines } from 'diff';

import { partitionWithinRoot, withinRoot } from 'opencode-harness-shared/path/Guard.ts';

export interface FileSnapshot {
	readonly absolutePath: string;
	readonly filePath: string;
	readonly beforeContent?: string | undefined;
}

export interface ChangedSpan {
	readonly start: number;
	readonly end: number;
}

/** Half-open spans occupied by text ADDED between before and after. */
export const computeChangedSpans = (
	before: string | undefined,
	after: string
): ReadonlyArray<ChangedSpan> => {
	if (before === undefined) return [{ start: 0, end: after.length }];
	let cursor = 0;
	return diffLines(before, after).reduce<ReadonlyArray<ChangedSpan>>(
		(spans, change) => {
			if (change.added === true) {
				const next = [
					...spans,
					{ start: cursor, end: cursor + change.value.length }
				];
				cursor += change.value.length;
				return next;
			}
			if (change.removed !== true) cursor += change.value.length;
			return spans;
		},
		[]
	);
};

const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_LINE = /^\*\*\* Move to: (.+)$/;

/** Affected paths declared inside apply_patch / patch text. */
export const extractPatchPaths = (patchText: string): ReadonlyArray<string> => [
	...new Set(
		patchText.split('\n').flatMap((line) => {
			const file =
				PATCH_FILE_LINE.exec(line)?.[1] ?? PATCH_MOVE_LINE.exec(line)?.[1];
			return file === undefined ? [] : [file.trim()];
		})
	)
];

/** Extract the file paths a mutating tool will affect. */
export const extractAffectedPaths = (
	toolName: string,
	input: unknown
): ReadonlyArray<string> => {
	const props = input !== null && typeof input === 'object' ? input : {};
	const get = (key: string) => Reflect.get(props, key);

	if (toolName === 'write' || toolName === 'edit' || toolName === 'multiedit') {
		const single = get('path') ?? get('filePath') ?? get('file');
		return typeof single === 'string' ? [single] : [];
	}
	if (toolName === 'apply_patch' || toolName === 'patch') {
		const text = get('patchText') ?? get('patch');
		return typeof text === 'string' ? extractPatchPaths(text) : [];
	}
	return [];
};

/**
 * Containment-checked resolution: host paths become absolute paths inside
 * `root`; anything escaping the project root is returned separately so callers
 * can enforce fail-closed policy instead of reading arbitrary files.
 */
export const resolveAffected = (
	root: string,
	paths: ReadonlyArray<string>
): {
	readonly snapshots: ReadonlyArray<FileSnapshot>;
	readonly escaped: ReadonlyArray<string>;
} => {
	const { escaped } = partitionWithinRoot(root, paths);
	const snapshots = paths.flatMap((filePath) => {
		const absolutePath = withinRoot(root, filePath);
		return absolutePath === undefined ? [] : [{ absolutePath, filePath }];
	});
	return { snapshots, escaped };
};
