/**
 * Runner scoring tests: deterministic acceptance criteria evaluation.
 */
import { describe, expect, it } from 'vitest';

import { AcceptanceCriterion } from '../src/Blueprint.ts';
import { Runner } from '../src/Runner.ts';

const criterion = (
	id: string,
	description: string,
	tag: 'command' | 'agent-judge' = 'command'
): AcceptanceCriterion =>
	({
		id,
		description,
		check:
			tag === 'command'
				? {
					_tag: 'command',
					command: {
						executable: 'echo',
						args: [],
						successExitCode: 0
					}
				}
				: {
					_tag: 'agent-judge',
					rubric: 'quality rubric',
					scoreMin: 0,
					scoreMax: 1
				}
	}) as unknown as AcceptanceCriterion;

describe('Runner', () => {
	describe('score', () => {
		it('returns score 0 with no criteria', () => {
			const result = Runner.score([], 'output');
			expect(result.passed).toBe(false);
		});

		it('scores command checks by output matching', () => {
			const result = Runner.score(
				[criterion('c1', 'output')],
				'this is the output of the run'
			);
			expect(result.score).toBe(1);
			expect(result.passed).toBe(true);
		});

		it('fails when output does not match any description', () => {
			const result = Runner.score(
				[criterion('c1', 'nonexistent-marker')],
				'unrelated output'
			);
			expect(result.score).toBe(0);
			expect(result.passed).toBe(false);
		});

		it('partial match gives partial score', () => {
			const result = Runner.score(
				[criterion('c1', 'found'), criterion('c2', 'missing')],
				'contains the word found here'
			);
			expect(result.score).toBeCloseTo(0.5);
			expect(result.passed).toBe(true);
		});
	});
});
