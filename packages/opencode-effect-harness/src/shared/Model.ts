/**
 * ModelReference — the single neutral model identity used by verification,
 * critic, compound, and every executor adapter. Host-branded refs are
 * converted to this value only at the adapter boundary.
 */
import { Schema } from 'effect';

export class ModelReference extends Schema.Class<ModelReference>('ModelReference')({
	provider: Schema.String,
	model: Schema.String,
	variant: Schema.optionalKey(Schema.String)
}) {}

export const modelLabel = (model: ModelReference): string =>
	`${model.provider}/${model.model}`;
