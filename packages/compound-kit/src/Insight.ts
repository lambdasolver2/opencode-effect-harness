/**
 * Insight — a Stage-1 candidate mined from session traces, with verbatim
 * evidence, a stable ID (assigned before Stage 2), and its trace provenance.
 */
import { Schema } from 'effect';

import { Digest } from './Trace.ts';

export const Kind = Schema.Literals([
	'failure-pattern',
	'recovery-strategy',
	'task-blueprint',
	'preference'
] as const);

export const Confidence = Schema.Literals(['low', 'medium', 'high'] as const);

export class CandidateInsight extends Schema.Class<CandidateInsight>(
	'CandidateInsight'
)({
	id: Schema.String,
	kind: Kind,
	domain: Schema.String,
	anchor: Schema.String,
	content: Schema.String,
	evidence: Schema.String,
	confidence: Confidence,
	trace: Digest,
	sourceSession: Schema.String
}) {}
