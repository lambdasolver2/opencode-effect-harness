/**
 * Headless companion CLI — review protocol + historical collection.
 *
 * Subcommands:
 *   sessions [--directory DIR]            list server sessions (sanitized metadata)
 *   export <sessionID>                    write sanitized transcript JSON to stdout
 *
 * Runs OUTSIDE the plugin process; talks to the server over HTTP like any
 * other client. No mutation of server state.
 */
import { Effect } from 'effect';

import { Collector } from './Collector.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'sessions';
const baseUrl =
	process.env.OPENCODE_BASE_URL ??
	`http://127.0.0.1:${process.env.OPENCODE_PORT ?? '49374'}`;

const program = Effect.gen(function* () {
	const collector = Collector.make({
		baseUrl,
		...(process.env.OPENCODE_DIRECTORY !== undefined
			? { directory: process.env.OPENCODE_DIRECTORY }
			: {})
	});

	if (command === 'sessions') {
		const summaries = yield* collector.list({ scope: 'project' });
		process.stdout.write(JSON.stringify(summaries, null, 2));
		return;
	}

	if (command === 'export') {
		const sessionID = args[1];
		if (sessionID === undefined) {
			process.stderr.write('usage: cli export <sessionID>\n');
			process.exitCode = 1;
			return;
		}
		const transcript = yield* collector.exportSanitized(sessionID);
		process.stdout.write(JSON.stringify(transcript, null, 2));
		return;
	}

	process.stderr.write(`unknown command: ${String(command)}\n`);
	process.exitCode = 1;
});

await Effect.runPromise(program.pipe(Effect.catchCause((cause: unknown) =>
	Effect.sync(() => {
		process.stderr.write(`collector error: ${String(cause)}\n`);
		process.exitCode = 1;
	})
)));
