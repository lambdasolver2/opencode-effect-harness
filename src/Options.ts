/**
 * Options — schema-validated plugin configuration decoded from `unknown`.
 *
 * Fixes the audited unchecked-cast surface: unknown fields follow an explicit
 * policy (ignored), impossible combinations fail conditionally BEFORE
 * registration, and the invalid-options policy (log + safe defaults) lives in
 * one place instead of being smeared across the composition root.
 */
import { Effect, Schema } from 'effect';

import { InvalidInput } from 'opencode-harness-shared';

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
	moduleIds: Schema.optionalKey(Schema.Array(Schema.String)),
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

const BenchmarkModelOption = Schema.Struct({
	id: Schema.String,
	provider: Schema.String,
	model: Schema.String,
	variant: Schema.optionalKey(Schema.String)
});

const RelativeDatabasePath = Schema.String.check(
	Schema.makeFilter<string>((value) =>
		value.length > 0 &&
		!value.startsWith('/') &&
		!value.split('/').some((segment) => segment === '..')
			? undefined
			: 'database path must be non-empty and stay within the project'
	)
);

const OtelOptions = Schema.Struct({
	/** OTLP/HTTP base URL, e.g. motel at http://127.0.0.1:27686 */
	endpoint: Schema.String,
	serviceName: Schema.optionalKey(Schema.String),
	/** Content (prompts/outputs) is NEVER exported; reserved for future opt-in. */
	includeContent: Schema.optionalKey(Schema.Literals([false]))
});

const BenchmarkOptions = Schema.Struct({
	dbPath: Schema.optionalKey(RelativeDatabasePath),
	concurrency: Schema.optionalKey(Schema.Number),
	workerAgent: Schema.optionalKey(Schema.String),
	judgeProfileId: Schema.optionalKey(Schema.String),
	timeoutMs: Schema.optionalKey(Schema.Number),
	models: Schema.optionalKey(Schema.Array(BenchmarkModelOption)),
	otel: Schema.optionalKey(OtelOptions)
});

const CompoundOptions = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	benchmark: Schema.optionalKey(BenchmarkOptions)
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
		readonly moduleIds: ReadonlyArray<string>;
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
		readonly benchmark: {
			readonly dbPath: string;
			readonly concurrency: number;
			readonly workerAgent: string;
			readonly judgeProfileId?: string | undefined;
			readonly timeoutMs: number;
			readonly models: ReadonlyArray<{
				readonly id: string;
				readonly provider: string;
				readonly model: string;
				readonly variant?: string | undefined;
			}>;
			readonly otel?: {
				readonly endpoint: string;
				readonly serviceName?: string | undefined;
				readonly includeContent?: false | undefined;
			} | undefined;
		};
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
		moduleIds: ['typescript'],
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
	compound: {
		enabled: false,
		benchmark: {
			dbPath: '.effect-harness/benchmark.sqlite',
			concurrency: 2,
			workerAgent: 'explore',
			judgeProfileId: undefined,
			timeoutMs: 240_000,
			models: []
		}
	}
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
				...(parsed.verify?.moduleIds !== undefined
					? { moduleIds: [...parsed.verify.moduleIds] }
					: {}),
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
					: { enabled: base.compound.enabled }),
				benchmark: {
					dbPath: parsed.compound?.benchmark?.dbPath ?? base.compound.benchmark.dbPath,
					concurrency:
						parsed.compound?.benchmark?.concurrency ?? base.compound.benchmark.concurrency,
					workerAgent:
						parsed.compound?.benchmark?.workerAgent ?? base.compound.benchmark.workerAgent,
					...(parsed.compound?.benchmark?.judgeProfileId !== undefined
						? { judgeProfileId: parsed.compound.benchmark.judgeProfileId }
						: {}),
				 timeoutMs: parsed.compound?.benchmark?.timeoutMs ?? base.compound.benchmark.timeoutMs,
				 models: [...(parsed.compound?.benchmark?.models ?? base.compound.benchmark.models)],
				 ...(parsed.compound?.benchmark?.otel !== undefined
					? { otel: parsed.compound.benchmark.otel }
					: {})
				}
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

		if (config.compound.benchmark.concurrency < 1 || config.compound.benchmark.concurrency > 16) {
			problems.push('compound.benchmark.concurrency must be between 1 and 16');
		}
		const duplicateProfileIds = config.compound.benchmark.models.length -
			new Set(config.compound.benchmark.models.map((m) => m.id)).size;
		if (duplicateProfileIds > 0) {
			problems.push('compound.benchmark.models has duplicate ids');
		}

		if (problems.length > 0) {
			return yield* Effect.fail(new InvalidInput({ reason: problems.join('; ') }));
		}
		return config;
	});
