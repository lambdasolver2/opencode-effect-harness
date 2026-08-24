import { Schema } from 'effect';

export namespace Skill {
	export interface Entry {
		readonly name: string;
		readonly skillFilePath: string;
		readonly skillDir: string;
	}

	export const entry = (name: string, filePath: string, dir: string): Entry => ({
		name,
		skillFilePath: filePath,
		skillDir: dir
	});

	/** Codec for serialization. */
	export const codec = Schema.Struct({
		name: Schema.String,
		skillFilePath: Schema.String,
		skillDir: Schema.String
	});
}
