/**
 * Options — schema-validated plugin configuration decoded from `unknown`.
 *
 * Fixes the audited unchecked-cast surface: unknown fields follow an explicit
 * policy (ignored), impossible combinations fail conditionally BEFORE
 * registration, and the invalid-options policy (log + safe defaults) lives in
 * one place instead of being smeared across the composition root.
 */
import { Effect, Schema } from 'effect';

import { InvalidInput } from '../shared/Errors.ts';

const NonEmptyStringArray = Schema.Array(Schema.String);

const HarnessOptions = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	minEffectSkills: Schema.optionalKey(Schema.Number),
	strictAgents: Schema.optionalKey(NonEmptyStringArray),
	failClosedForGate: Schema.optionalKey(Schema.Boolean),
	allowEdits: Schema.optionalKey(Schema.Boolean),
	assetsRoot: Schema.optionalKey(Schema.String)
});

const VerifyOptions = Schema.Struct({
	trigger: Schema.optionalKey(Schema.Literals(['off', 'auto', 'manual'])),
	semanticReview: Schema.optionalKey(Schema.Boolean),
	workerAgent: Schema.optionalKey(Schema.String),
	maxFindings: Schema.optionalKey(Schema.Number)
});

const CriticOptions = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	workerAgent: Schema.optionalKey(Schema.String),
	requireIndependentModel: Schema.optionalKey(Schema.Boolean),
	checkReferences: Schema.optionalKey(Schema.Boolean),
	autoAfterExplicitCheckpoint: Schema.optionalKey(Schema.Boolean),
	autoEveryNBuildExecutions: Schema.optionalKey(Schema.Number)
});

const CompoundOptions = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean)
});

const RawOptions = Schema.Struct({
	harness: Schema.optionalKey(HarnessOptions),
	verify: Schema.optionalKey(VerifyOptions),
	critic: Schema.optionalKey(CriticOptions),
	compound: Schema.optionalKey(CompoundOptions)
});

export interface ValidOptions {
	readonly harness: {
		readonly enabled: boolean;
		readonly minEffectSkills: number;
		readonly strictAgents: ReadonlyArray<string>;
		readonly failClosedForGate: boolean;
		readonly allowEdits: boolean;
		readonly assetsRoot?: string | undefined;
	};
	readonly verify: {
		readonly trigger: 'off' | 'auto' | 'manual';
		readonly semanticReview: boolean;
		readonly workerAgent: string;
		readonly maxFindings: number;
	};
	readonly critic: {
		readonly enabled: boolean;
		readonly workerAgent: string;
		readonly requireIndependentModel: boolean;
		readonly checkReferences: boolean;
		readonly autoAfterExplicitCheckpoint: boolean;
		readonly autoEveryNBuildExecutions: number;
	};
	readonly compound: {
		readonly enabled: boolean;
	};
}

export const defaults = (): ValidOptions => ({
	harness: {
		enabled: true,
		minEffectSkills: 4,
		strictAgents: ['build'],
		failClosedForGate: true,
		allowEdits: false
	},
	verify: {
		trigger: 'manual',
		semanticReview: true,
		workerAgent: 'explore',
		maxFindings: 20
	},
	critic: {
		enabled: true,
		workerAgent: 'explore',
		requireIndependentModel: false,
		checkReferences: true,
		autoAfterExplicitCheckpoint: false,
		autoEveryNBuildExecutions: 0
	},
	compound: { enabled: false }
});

/** Decode raw `ctx.options` into validated config; unknown fields ignored. */
export const decode = (raw: unknown): Effect.Effect<ValidOptions, InvalidInput> =>
	Effect.gen(function*() {
		const parsed = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(RawOptions)(raw),
			catch: (cause) =>
				new InvalidInput({ reason: `malformed options: ${String(cause)}` })
		});

		const base = defaults();
		const config: ValidOptions = {
			harness: {
				...base.harness,
				...(parsed.harness?.enabled !== undefined ? { enabled: parsed.harness.enabled } : {}),
				...(parsed.harness?.minEffectSkills !== undefined
					? { minEffectSkills: parsed.harness.minEffectSkills }
					: {}),
				...(parsed.harness?.strictAgents !== undefined
					? { strictAgents: [...parsed.harness.strictAgents] }
					: {}),
				...(parsed.harness?.failClosedForGate !== undefined
					? { failClosedForGate: parsed.harness.failClosedForGate }
					: {}),
				...(parsed.harness?.allowEdits !== undefined
					? { allowEdits: parsed.harness.allowEdits }
					: {}),
				...(parsed.harness?.assetsRoot !== undefined
					? { assetsRoot: parsed.harness.assetsRoot }
					: {})
			},
			verify: {
				...base.verify,
				...(parsed.verify?.trigger !== undefined ? { trigger: parsed.verify.trigger } : {}),
				...(parsed.verify?.semanticReview !== undefined
					? { semanticReview: parsed.verify.semanticReview }
					: {}),
				...(parsed.verify?.workerAgent !== undefined
					? { workerAgent: parsed.verify.workerAgent }
					: {}),
				...(parsed.verify?.maxFindings !== undefined
					? { maxFindings: parsed.verify.maxFindings }
					: {})
			},
			critic: {
				...base.critic,
				...(parsed.critic?.enabled !== undefined ? { enabled: parsed.critic.enabled } : {}),
				...(parsed.critic?.workerAgent !== undefined
					? { workerAgent: parsed.critic.workerAgent }
					: {}),
				...(parsed.critic?.requireIndependentModel !== undefined
					? { requireIndependentModel: parsed.critic.requireIndependentModel }
					: {}),
				...(parsed.critic?.checkReferences !== undefined
					? { checkReferences: parsed.critic.checkReferences }
					: {}),
				...(parsed.critic?.autoAfterExplicitCheckpoint !== undefined
					? { autoAfterExplicitCheckpoint: parsed.critic.autoAfterExplicitCheckpoint }
					: {}),
				...(parsed.critic?.autoEveryNBuildExecutions !== undefined
					? { autoEveryNBuildExecutions: parsed.critic.autoEveryNBuildExecutions }
					: {})
			},
			compound: {
				...(parsed.compound?.enabled !== undefined
					? { enabled: parsed.compound.enabled }
					: base.compound)
			}
		};

		return yield* validate(config);
	});

const validate = (config: ValidOptions): Effect.Effect<ValidOptions, InvalidInput> =>
	Effect.gen(function*() {
		const problems: Array<string> = [];

		if (config.harness.minEffectSkills < 0 || config.harness.minEffectSkills > 50) {
			problems.push('harness.minEffectSkills must be between 0 and 50');
		}
		if (config.harness.strictAgents.includes('*')) {
			problems.push('harness.strictAgents must list explicit agent IDs');
		}

		if (
			config.critic.autoAfterExplicitCheckpoint &&
			config.critic.autoEveryNBuildExecutions > 0
		) {
			problems.push(
				'critic auto triggers are mutually exclusive: pick checkpoint-based OR cadence-based'
			);
		}
		if (config.critic.enabled && config.critic.autoEveryNBuildExecutions < 0) {
			problems.push('critic.autoEveryNBuildExecutions must be >= 0');
		}

		if (problems.length > 0) {
			return yield* Effect.fail(new InvalidInput({ reason: problems.join('; ') }));
		}
		return config;
	});
