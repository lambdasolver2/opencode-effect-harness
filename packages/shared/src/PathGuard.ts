/**
 * PathGuard — pure project-root containment for every host-supplied path.
 *
 * Snapshot capture, verification reads, and ChangeSet construction MUST pass
 * through this guard: a path that resolves outside the configured project root
 * is rejected instead of being read. No filesystem access happens here, so the
 * check is total and trivially testable.
 */

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

export const isAbsoluteish = (value: string): boolean =>
	value.startsWith('/') || WINDOWS_ABSOLUTE.test(value);

/**
 * Collapse `.`/`..` segments. Returns `undefined` when a `..` climbs above
 * the path root — escaping is REJECTED, never silently clamped.
 */
const normalizeSegments = (
	value: string
): ReadonlyArray<string> | undefined =>
	value.split('/').reduce<ReadonlyArray<string> | undefined>(
		(acc, segment) => {
			if (acc === undefined) return undefined;
			if (segment.length === 0 || segment === '.') return acc;
			if (segment === '..') {
				if (acc === undefined || acc.length === 0) return undefined;
				return acc.slice(0, -1);
			}
			return [...(acc ?? []), segment];
		},
		[]
	);

/**
 * Resolve `target` against `root` and return its absolute normalized form,
 * or `undefined` when it escapes the root (or is an outside absolute path).
 */
export const withinRoot = (root: string, target: string): string | undefined => {
	const cleanRoot = root.replace(/\/+$/, '');
	const rootSegments = normalizeSegments(cleanRoot);
	if (rootSegments === undefined) return undefined;
	const prefix = `/${rootSegments.join('/')}`;
	if (isAbsoluteish(target)) {
		const segments = normalizeSegments(target.replace(/\\/g, '/'));
		if (segments === undefined) return undefined;
		const absolute = `/${segments.join('/')}`;
		return absolute === prefix || absolute.startsWith(`${prefix}/`)
			? absolute
			: undefined;
	}
	const segments = normalizeSegments(target.replace(/\\/g, '/'));
	if (segments === undefined || segments.length === 0) return undefined;
	return `${prefix}/${segments.join('/')}`;
};

/** Split paths into contained absolute paths and rejected escape attempts. */
export const partitionWithinRoot = (
	root: string,
	targets: ReadonlyArray<string>
): {
	readonly contained: ReadonlyArray<string>;
	readonly escaped: ReadonlyArray<string>;
} => {
	const contained = targets.flatMap((target) => {
		const resolved = withinRoot(root, target);
		return resolved === undefined ? [] : [resolved];
	});
	const escaped = targets.filter(
		(target) => withinRoot(root, target) === undefined
	);
	return { contained, escaped };
};
