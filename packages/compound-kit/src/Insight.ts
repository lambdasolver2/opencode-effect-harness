/**
 * Insight — a Stage-1 candidate mined from session traces, with verbatim
 * evidence and a bounded solution-trace digest.
 */
import { Schema } from 'effect';

import { Digest as TraceDigest } from './Trace.ts';

export const Kind = Schema.Literals([
	'failure-pattern',
	'recovery-strategy',
	'task-blueprint',
	'preference'
] as const);

export const Confidence = Schema.Literals(['low', 'medium', 'high'] as const);

export class Insight extends Schema.Class<Insight>('Insight')({
	id: Schema.String,
	kind: Kind,
	domain: Schema.String,
	anchor: Schema.String,
	content: Schema.String,
	evidence: Schema.String,
	trace: TraceDigest,
	confidence: Confidence,
	sourceSession: Schema.String
}) {}

export class GateDecision extends Schema.Class<GateDecision>('GateDecision')({
	insightId: Schema.String,
	decision: Schema.Literals(['approve', 'reject']),
	reason: Schema.optionalKey(Schema.String),
	rewrittenContent: Schema.optionalKey(Schema.String),
	gateNote: Schema.optionalKey(Schema.String)
}) {}
