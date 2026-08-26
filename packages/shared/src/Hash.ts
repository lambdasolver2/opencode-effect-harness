/**
 * Hash — the ONE deterministic fingerprint helper (FNV-1a over code points).
 *
 * Shared by the Journal chain seal and the asset-manifest integrity check.
 * This is an ORDERING/DRIFT fingerprint, not a cryptographic signature: it
 * detects accidental truncation, reordering, and content replacement — it does
 * not defend a determined adversary.
 */

/** 8-hex-digit FNV-1a fingerprint of a string. */
export const fnv1aHex = (input: string): string => {
	const hash = [...input].reduce(
		(state, ch) => Math.imul(state ^ (ch.codePointAt(0) ?? 0), 0x01000193),
		0x811c9dc5
	);
	return (hash >>> 0).toString(16).padStart(8, '0');
};
