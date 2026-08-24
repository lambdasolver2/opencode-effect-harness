/**
 * Common typed errors shared across contexts. Context-specific errors remain
 * in their own domains; these cover cross-cutting failure classes so callers
 * can handle them uniformly without importing every module.
 */
import { Schema } from 'effect';

export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
	'InvalidInput',
	{ reason: Schema.String }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
	what: Schema.String
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()(
	'Unavailable',
	{
		capability: Schema.String,
		reason: Schema.String
	}
) {}

export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
	reason: Schema.String
}) {}
