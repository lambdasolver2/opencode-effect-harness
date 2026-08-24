/**
 * Proposals — the durable human-approval queue between Stage 2 and
 * materialization. Built on the shared append-only Journal: nothing is ever
 * edited; approve/edit/skip/reject/abort are new events. Headless callers
 * leave proposals pending forever until an explicit decision event exists.
 */
import { Context, Effect, Layer, Schema } from 'effect';

import { Journal } from '../shared/Journal.ts';
import { CandidateInsight } from './Insight.ts';

export class PendingProposal extends Schema.Class<PendingProposal>('PendingProposal')({
	id: Schema.String,
	insight: CandidateInsight,
	proposedAt: Schema.Number
}) {}

export const ProposalDecision = Schema.Literals([
	'approve',
	'edit-approve',
	'skip',
	'reject',
	'abort'
] as const);
export type ProposalDecision = Schema.Schema.Type<typeof ProposalDecision>;

export interface DecisionInput {
	readonly id: string;
	readonly decision: Exclude<ProposalDecision, never> | ProposalDecision;
	readonly reason?: string | undefined;
	readonly rewrittenContent?: string | undefined;
	readonly requestId?: string | undefined;
	readonly actor?: string | undefined;
}

export namespace Proposals {
	export interface Service {
		propose(input: {
			readonly stream: string;
			readonly insight: CandidateInsight;
			readonly now: number;
		}): Effect.Effect<string>;
		pending(stream: string): Effect.Effect<ReadonlyArray<PendingProposal>>;
		status(stream: string): Effect.Effect<
			ReadonlyArray<{
				readonly id: string;
				readonly status:
					| 'pending'
					| 'approved'
					| 'edited-approved'
					| 'skipped'
					| 'rejected';
				readonly content?: string | undefined;
			}>
		>;
		decide(stream: string, input: DecisionInput): Effect.Effect<void>;
	}

	export class Tag extends Context.Service<Tag, Service>()(
		'opencode-effect-harness/compound/Proposals'
	) {}

	const proposalId = (insightId: string): string => `prop-${insightId}`;

	export const make = (journal: Journal.Interface): Service => ({
		propose: ({ stream, insight, now }) =>
			Effect.map(
				journal.append({
					stream,
					kind: 'proposal.proposed',
					requestId: proposalId(insight.id),
					payload: { insight },
					now
				}),
				() => proposalId(insight.id)
			).pipe(Effect.orElseSucceed(() => proposalId(insight.id))),

		pending: (stream) =>
			Effect.map(statusAll(journal, stream), (all) =>
				all
					.filter((entry) => entry.status === 'pending')
					.map((entry) =>
						new PendingProposal({
							id: entry.id,
							insight: entry.insight,
							proposedAt: 0
						})
					)
			),

		status: (stream) =>
			Effect.map(statusAll(journal, stream), (all) =>
				all.map((entry) => ({
					id: entry.id,
					status: entry.status,
					...(entry.content !== undefined ? { content: entry.content } : {})
				}))
			),

		decide: (stream, input) =>
			journal.append({
				stream,
				kind: `proposal.${input.decision}`,
				actor: input.actor,
				requestId: input.requestId ?? `${input.decision}:${input.id}`,
				payload: {
					proposalId: input.id,
					reason: input.reason,
					rewrittenContent: input.rewrittenContent
				}
			}).pipe(Effect.asVoid, Effect.orElseSucceed(() => undefined))
	});

	const statusAll = (
		journal: Journal.Interface,
		stream: string
	): Effect.Effect<
		ReadonlyArray<{
			readonly id: string;
			readonly insight: CandidateInsight;
			readonly status:
				| 'pending'
				| 'approved'
				| 'edited-approved'
				| 'skipped'
				| 'rejected';
			readonly content?: string | undefined;
		}>
	> =>
		Effect.map(Effect.orElseSucceed(journal.read(stream), () => []), (entries) => {
			type Row = {
				id: string;
				insight: CandidateInsight;
				status: 'pending' | 'approved' | 'edited-approved' | 'skipped' | 'rejected';
				content?: string | undefined;
			};
			const safeDecode = (value: unknown): CandidateInsight | undefined => {
				try {
					return Schema.decodeUnknownSync(CandidateInsight)(value);
				} catch {
					return undefined;
				}
			};

			const table = entries.reduce<Map<string, Row>>((acc, entry) => {
				const payload = entry.payload as Record<string, unknown> | null;

				if (entry.kind === 'proposal.proposed' && payload !== null) {
					const insight = safeDecode(payload.insight);
					if (insight !== undefined) {
						const id = proposalId(insight.id);
						acc.set(id, { id, insight, status: 'pending' });
					}
					return acc;
				}

				const proposalIdValue = String(payload?.proposalId ?? '');
				const existing = acc.get(proposalIdValue);
				if (existing === undefined) return acc;

				const next: Row =
					entry.kind === 'proposal.approve'
						? { ...existing, status: 'approved' }
						: entry.kind === 'proposal.edit-approve'
							? {
								...existing,
								status: 'edited-approved',
								content:
									typeof payload?.rewrittenContent === 'string'
										? payload.rewrittenContent
										: existing.content
							  }
							: entry.kind === 'proposal.skip'
								? { ...existing, status: 'skipped' }
								: entry.kind === 'proposal.reject'
									? { ...existing, status: 'rejected' }
									: existing;
				acc.set(proposalIdValue, next);
				return acc;
			}, new Map<string, Row>());

			const rows = [...table.entries()].map(([, row]) => row);
			return rows.map((row) => ({
				id: row.id,
				insight: row.insight,
				status: row.status,
				...(row.content !== undefined ? { content: row.content } : {})
			}));
		});
	export const layer = (journal: Journal.Interface): Layer.Layer<Tag> =>
		Layer.succeed(Tag, Tag.of(make(journal)));
}
