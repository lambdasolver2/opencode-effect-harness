import { Schema } from 'effect';

export const Slug = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/, { message: 'invalid slug' })
);
export type Slug = Schema.Schema.Type<typeof Slug>;
