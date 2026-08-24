/**
 * Evidence — deterministic required-skill assessment. Answers: did the session
 * have enough distinct relevant skills loaded when framework code was written?
 * Pure; no I/O; trivially property-testable.
 */
import { Schema } from 'effect';

export const EvidenceStatus = Schema.Literals([
	'sufficient',
	'insufficient',
	'skipped'
] as const);
export type EvidenceStatus = Schema.Schema.Type<typeof EvidenceStatus>;

export class SkillEvidence extends Schema.Class<SkillEvidence>('SkillEvidence')({
	status: EvidenceStatus,
	loadedSkills: Schema.Array(Schema.String),
	minRequired: Schema.Number,
	reason: Schema.optionalKey(Schema.String)
}) {}

export interface AssessInput {
	readonly codeDetected: boolean;
	readonly loadedSkills: ReadonlyArray<string>;
	readonly minRequired: number;
}

export const assessEvidence = (input: AssessInput): SkillEvidence => {
	if (!input.codeDetected || input.minRequired <= 0) {
		return new SkillEvidence({
			status: 'skipped',
			loadedSkills: [...input.loadedSkills],
			minRequired: input.minRequired
		});
	}
	const distinct = new Set(input.loadedSkills).size;
	const sufficient = distinct >= input.minRequired;
	return new SkillEvidence({
		status: sufficient ? 'sufficient' : 'insufficient',
		loadedSkills: [...input.loadedSkills],
		minRequired: input.minRequired,
		...(sufficient
			? {}
			: {
				reason: `${distinct} distinct relevant skills loaded, ${input.minRequired} required`
			})
	});
};
