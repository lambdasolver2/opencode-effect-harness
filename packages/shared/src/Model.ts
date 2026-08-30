/**
 * ModelReference — the single neutral model identity used by verification,
 * critic, compound, and every executor adapter. Host-branded refs are
 * converted to this value only at the adapter boundary.
 */
import { Effect, Schema } from 'effect';

import { InvalidInput } from './Errors.ts';

const NonEmptyNoSlashHash = Schema.NonEmptyString.check(
	Schema.isPattern(/^[^/#]+$/, { message: 'must not contain / or #' })
);

export class ModelReference extends Schema.Class<ModelReference>('ModelReference')({
	provider: NonEmptyNoSlashHash,
	model: NonEmptyNoSlashHash,
	variant: Schema.optionalKey(NonEmptyNoSlashHash)
}) {}

export const parseModelKey = (label: string): Effect.Effect<ModelReference, InvalidInput> =>
	Effect.try({
		try: () => {
			const hashIdx = label.indexOf('#');
			const slashIdx = label.indexOf('/');
			if (slashIdx === -1) throw new Error('missing /');
			if (hashIdx !== -1 && hashIdx < slashIdx) throw new Error('misplaced #');
			const provider = label.slice(0, slashIdx);
			const model = hashIdx === -1 ? label.slice(slashIdx + 1) : label.slice(slashIdx + 1, hashIdx);
			const variant = hashIdx === -1 ? undefined : label.slice(hashIdx + 1);
			if (provider.length === 0 || model.length === 0) throw new Error('empty segment');
			if (variant !== undefined && variant.length === 0) throw new Error('empty variant');
			const candidate: Record<string, unknown> = { provider, model, ...(variant !== undefined ? { variant } : {}) };
			return Schema.decodeUnknownSync(ModelReference)(candidate);
		},
		catch: (cause) => new InvalidInput({ reason: `invalid model key ${label}: ${String(cause)}` })
	});

export const modelLabel = (model: ModelReference): string =>
	`${model.provider}/${model.model}`;

/**
 * Variant-aware identity key (`provider/model` or `provider/model#variant`,
 * matching the OpenCode `Model.Ref.parse` convention). Two variants of one
 * model are DISTINCT benchmark identities — aggregation/trial keys MUST use
 * this, never `modelLabel`.
 */
export const modelKey = (model: ModelReference): string =>
	model.variant === undefined
		? `${model.provider}/${model.model}`
		: `${model.provider}/${model.model}#${model.variant}`;
