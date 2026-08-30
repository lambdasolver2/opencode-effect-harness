/**
 * Neutral reference values shared across contexts. Host-branded identifiers
 * are converted into these values only at adapter boundaries; core modules
 * never import OpenCode-branded types.
 */
import { Schema } from 'effect';

import { fnv1aHex } from './Hash.ts';

/** Stable, path-safe project identity derived from the absolute root — single hash (FNV-1a) per AUDIT-046. */
export const projectKeyOf = (absoluteRoot: string): string => fnv1aHex(absoluteRoot);

const ProjectKeyBrand = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}$/, { message: 'projectKey must be 8-hex' })
);
const AbsolutePathBrand = Schema.NonEmptyString;

export class ProjectScope extends Schema.Class<ProjectScope>('ProjectScope')({
	projectKey: ProjectKeyBrand,
	root: AbsolutePathBrand
}) {}

export const SessionOrigin = Schema.Literals(['builder', 'verifier', 'critic', 'compound', 'benchmark'] as const);
export type SessionOrigin = Schema.Schema.Type<typeof SessionOrigin>;

export class SessionRef extends Schema.Class<SessionRef>('SessionRef')({
	sessionID: Schema.NonEmptyString,
	projectKey: ProjectKeyBrand,
	origin: SessionOrigin
}) {}

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
