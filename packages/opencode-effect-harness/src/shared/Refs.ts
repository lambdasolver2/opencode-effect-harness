/**
 * Neutral reference values shared across contexts. Host-branded identifiers
 * are converted into these values only at adapter boundaries; core modules
 * never import OpenCode-branded types.
 */
import { Schema } from 'effect';

/** Stable, path-safe project identity derived from the absolute root. */
export const projectKeyOf = (absoluteRoot: string): string => {
	const hash = [...absoluteRoot].reduce(
		(state, ch) => ((state << 5) + state + (ch.codePointAt(0) ?? 0)) >>> 0,
		5381
	);
	return hash.toString(16).padStart(8, '0');
};

export class ProjectScope extends Schema.Class<ProjectScope>('ProjectScope')({
	projectKey: Schema.String,
	root: Schema.String
}) {}

export type SessionOrigin =
	| 'builder'
	| 'verifier'
	| 'critic'
	| 'compound'
	| 'benchmark';

export interface SessionRef {
	readonly sessionID: string;
	readonly projectKey: string;
	readonly origin: SessionOrigin;
}

/** Immutable pointer to a reviewed snapshot (source/spec/plan revision). */
export class SnapshotRef extends Schema.Class<SnapshotRef>('SnapshotRef')({
	repositoryHash: Schema.String,
	specRevisions: Schema.Array(Schema.String),
	planRevision: Schema.optionalKey(Schema.String),
	contentHash: Schema.String
}) {}

/** Reference to a persisted artifact with integrity metadata. */
export class ArtifactRef extends Schema.Class<ArtifactRef>('ArtifactRef')({
	path: Schema.String,
	sha256: Schema.String,
	bytes: Schema.Number
}) {}
