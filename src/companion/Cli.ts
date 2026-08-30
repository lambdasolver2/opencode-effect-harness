/**
 * Headless companion CLI — review protocol + historical collection.
 *
 * Subcommands:
 *   sessions [--directory DIR]            list server sessions (sanitized metadata)
 *   export <sessionID>                    write sanitized transcript JSON to stdout
 *   bench tasks|profiles|job|leading|history|trace [--db PATH]
 *                                         read-only view of the benchmark store
 *
 * Runs OUTSIDE the plugin process; talks to the server over HTTP like any
 * other client. No mutation of server state. The bench subcommands read the
 * benchmark SQLite store directly (read-only intent; the store layer still
 * opens the file normally).
 */
import { Effect, FileSystem, Layer, Option, Path } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import * as CollectorModule from './Collector.ts';
import { TaskStore } from 'opencode-compound-kit/task/Store.ts';
import { TaskError } from 'opencode-compound-kit/Task.ts';
import { fnv1aHex } from 'opencode-harness-shared/Hash.ts';
import { Runner } from '../benchmark/Runner.ts';
import { Executor, ExecutorError } from '../session/Executor.ts';
import { ClientExecutor } from '../session/Client.ts';
import { ModelProfile } from 'opencode-compound-kit/Task.ts';
import { OpenCode } from '@opencode-ai/client/effect';
import { discover, headers } from '@opencode-ai/client/effect/service';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { SqliteStore } from 'opencode-bench-store';

const args = process.argv.slice(2);
const command = args[0] ?? 'sessions';
const baseUrl =
	process.env.OPENCODE_BASE_URL ??
	`http://127.0.0.1:${process.env.OPENCODE_PORT ?? '49374'}`;

const dbArgIndex = args.indexOf('--db');
const dbPath =
	dbArgIndex === -1
		? process.env.OPENCODE_BENCH_DB ?? '.effect-harness/benchmark.sqlite'
		: (args[dbArgIndex + 1] ?? '.effect-harness/benchmark.sqlite');

const positional = args.filter(
	(arg, index) => index > 0 && arg !== '--db' && args[index - 1] !== '--db'
);

const benchProgram = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const resolved = path.resolve(dbPath);
	const exists = yield* fs.exists(resolved);
	if (!exists) {
		process.stdout.write(`no benchmark store at ${resolved}\n`);
		return;
	}

	const withStore = <A>(
		effect: Effect.Effect<A, TaskError, TaskStore.Tag>
	): Effect.Effect<A, TaskError, never> =>
		Effect.mapError(
			Effect.provide(effect, SqliteStore.layer({ _tag: 'File', path: resolved }, platform)),
			(cause): TaskError => new TaskError({ operation: 'store', reason: String(cause) })
		);

	const write = (value: unknown) =>
		Effect.sync(() => {
			process.stdout.write(JSON.stringify(value, null, 2));
		});

	const benchArgs = positional;

	if (benchArgs[0] === 'tasks') {
		const page = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.listTasks(benchArgs[1])));
		yield* write({
			items: page.items.map((task) => ({
				id: task.spec.taskId,
				revision: task.revision,
				title: task.spec.title,
				profiles: [...task.spec.modelProfileIds]
			})),
			nextCursor: Option.getOrNull(page.nextCursor)
		});
		return;
	}
	if (benchArgs[0] === 'profiles') {
		const profiles = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.listProfiles()));
		yield* write({ items: [...profiles] });
		return;
	}
	if (benchArgs[0] === 'job') {
		const jobId = benchArgs[1];
		if (jobId === undefined) {
			process.stderr.write('usage: cli bench job <jobId>\n');
			process.exitCode = 1;
			return;
		}
		const jobOption = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.getJob(jobId)));
		if (Option.isNone(jobOption)) {
			process.stdout.write(`unknown job ${jobId}\n`);
			return;
		}
		const trials = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.listTrials(jobId)));
		const scores = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.listScores(jobId)));
		const leading = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.getLeading(jobId)));
		yield* write({
			job: jobOption.value,
			trials: trials.map((trial) => ({
				trialId: trial.trialId,
				profileId: trial.profileId,
				variant: trial.variant ?? null,
				status: trial.status,
				durationMs: trial.durationMs ?? null,
				outputChars: trial.outputBytes ?? null
			})),
			scores: scores.map((score) => ({ trialId: score.trialId, total: score.total })),
			leading: Option.getOrNull(leading)
		});
		return;
	}
	if (benchArgs[0] === 'leading') {
		const jobId = benchArgs[1];
		if (jobId === undefined) {
			process.stderr.write('usage: cli bench leading <jobId>\n');
			process.exitCode = 1;
			return;
		}
		const leading = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.getLeading(jobId)));
		yield* write(Option.getOrNull(leading));
		return;
	}
	if (benchArgs[0] === 'history') {
		const jobId = benchArgs[1];
		if (jobId === undefined) {
			process.stderr.write('usage: cli bench history <jobId>\n');
			process.exitCode = 1;
			return;
		}
		const history = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.listHistory(jobId)));
		yield* write({ items: [...history] });
		return;
	}
	if (benchArgs[0] === 'run') {
		// bench run <taskId> --model provider/model[#variant] [--agent AGENT]
		// Real end-to-end: talks to the opencode2 server as a client.
		const taskId = benchArgs[1];
		const modelIndex = args.indexOf('--model');
		const modelRef = modelIndex === -1 ? undefined : args[modelIndex + 1];
		if (taskId === undefined || modelRef === undefined) {
			process.stderr.write('usage: cli bench run <taskId> --model provider/model[#variant] [--agent AGENT]\n');
			process.exitCode = 1;
			return;
		}
		const slash = modelRef.indexOf('/');
		if (slash <= 0) {
			process.stderr.write(`invalid model reference: ${modelRef} (expected provider/model[#variant])\n`);
			process.exitCode = 1;
			return;
		}
		const hash = modelRef.indexOf('#');
		const provider = modelRef.slice(0, slash);
		const modelId = modelRef.slice(slash + 1, hash === -1 ? undefined : hash);
		const variant = hash === -1 ? undefined : modelRef.slice(hash + 1);
		// Slug-safe profile id: model ids may contain dots (e.g. 3.0).
		const profileId = `cli-${modelId.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
		const runProfile = new ModelProfile({
			id: profileId,
			provider,
			model: modelId,
			...(variant !== undefined ? { variant } : {})
		});

		const runEffect = Effect.gen(function* () {
			const store = yield* TaskStore.Tag;
			const taskOption = yield* store.getTask(taskId);
			const task = Option.match(taskOption, {
				onNone: () => null,
				onSome: (value) => value
			});
			if (task === null) {
				process.stderr.write(`unknown task ${taskId}\n`);
				process.exitCode = 1;
				return;
			}

			// Client transport: discover the registered service, else --server/--password.
			const serverIndex = args.indexOf('--server');
			const pwIndex = args.indexOf('--password');
			const endpoint =
				serverIndex !== -1 && pwIndex !== -1
					? { url: args[serverIndex + 1], password: args[pwIndex + 1] }
					: yield* Effect.orElseSucceed(
							Effect.mapError(discover(), (cause) => String(cause)),
							() => undefined
						);
			if (endpoint === undefined) {
				process.stderr.write('no opencode2 server: start one or pass --server/--password\n');
				process.exitCode = 1;
				return;
			}
			// OpenCode.make has no headers option at type level: wrap the
			// HttpClient with the authenticated request header instead.
			// The server accepts Basic auth with username `opencode` and its
			// printed password (verified via /api/health probe).
			const endpointRecord = endpoint as { url?: string; password?: string; auth?: { type: string; username: string; password: string } };
			const password =
				endpointRecord.password ??
				(endpointRecord.auth !== undefined && endpointRecord.auth.type === 'basic'
					? endpointRecord.auth.password
					: '');
			const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
			const AuthClient = Layer.effect(
				HttpClient.HttpClient,
				Effect.map(
					Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer),
					(client) => HttpClient.mapRequest(client, (request) =>
						HttpClientRequest.setHeader(request, 'authorization', authHeader)
					)
				)
			);
			const client = yield* OpenCode.make({
				baseUrl: endpoint.url ?? 'http://127.0.0.1:49374'
			}).pipe(Effect.provide(AuthClient));

			// Catalog check for the exact model + variant.
			const catalog = yield* client.model.list().pipe(
				Effect.mapError((cause): TaskError => new TaskError({ operation: 'model', reason: String(cause) }))
			);
			const known = catalog.data.find(
				(entry) => entry.providerID === provider && entry.id === modelId
			);
			if (known === undefined) {
				process.stderr.write(`model ${provider}/${modelId} not in catalog\n`);
				process.exitCode = 1;
				return;
			}
			if (variant !== undefined && !known.variants.some((v) => v.id === variant)) {
				process.stderr.write(`variant '${variant}' not available for ${provider}/${modelId}\n`);
				process.exitCode = 1;
				return;
			}

			// Upsert the run profile, then execute the job with the client executor.
			yield* store.upsertProfile(runProfile);
			const execDeps = ClientExecutor.make({
				catalogModelList: () => Effect.succeed({ data: catalog.data }),
				createSession: (input) =>
					Effect.mapError(
						client.session.create({
							agent: input.agent as never,
							model: input.model as never,
							location: input.location as never,
							title: input.title
						}),
						(cause): ExecutorError =>
							new ExecutorError({ operation: 'session', reason: String(cause) })
					),
				generate: (input) =>
					Effect.mapError(
						client.session.generate({
							sessionID: input.sessionID as never,
							prompt: `${input.system}\n\n${input.prompt}`
						}),
						(cause): ExecutorError =>
							new ExecutorError({ operation: 'generate', reason: String(cause) })
					),
				interrupt: (sessionID) =>
					Effect.orElseSucceed(
						Effect.mapError(
							client.session.interrupt({ sessionID: sessionID as never }),
							(cause) => String(cause)
						),
						() => undefined
					)
			});

			const summary = yield* Runner.run(
				{
					store,
					executor: Executor.make(execDeps),
					workspaceDirFor: (label) =>
						Effect.gen(function* () {
							const path = yield* Path.Path;
							const fs = yield* FileSystem.FileSystem;
							const dir = path.join(process.cwd(), '.effect-harness', 'workspaces', `job-${fnv1aHex(label)}`);
							yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
							return dir;
						}).pipe(Effect.provide(platform)),
					cleanupWorkspace: (dir) =>
						Effect.gen(function* () {
							const fs = yield* FileSystem.FileSystem;
							yield* fs.remove(dir, { recursive: true });
						}).pipe(Effect.provide(platform), Effect.ignore),
					workerAgent: 'plan',
					timeoutMs: 240_000
				},
				{ task, profiles: [runProfile], trials: 1, concurrency: 1 }
			);

			const scores = yield* store.listScores(summary.jobId);
			yield* write({
				jobId: summary.jobId,
				outcomes: [...summary.outcomes],
				leading: Option.isSome(Option.fromNullishOr(summary.leadingTrialId))
					? {
						trialId: summary.leadingTrialId,
						total: scores.find((score) => score.trialId === summary.leadingTrialId)?.total ?? null
					}
					: null
			});
		});
		yield* withStore(runEffect.pipe(Effect.provide(platform)));
		return;
	}
	if (benchArgs[0] === 'trace') {
		const trialId = benchArgs[1];
		if (trialId === undefined) {
			process.stderr.write('usage: cli bench trace <trialId>\n');
			process.exitCode = 1;
			return;
		}
		const trace = yield* withStore(Effect.flatMap(TaskStore.Tag, (store) => store.listTrace(trialId)));
		yield* write({ items: [...trace] });
		return;
	}
	process.stderr.write(
		'usage: cli bench tasks|profiles|run <taskId> --model provider/model[#variant]|job <id>|leading <id>|history <id>|trace <trialId> [--db PATH]\n'
	);
	process.exitCode = 1;
});

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const program = Effect.gen(function* () {
	const collector = CollectorModule.make({
		
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

	if (command === 'bench') {
		yield* benchProgram;
		return;
	}

	process.stderr.write(`unknown command: ${String(command)}\n`);
	process.exitCode = 1;
});

await Effect.runPromise(program.pipe(
	Effect.catchCause((cause: unknown) =>
		Effect.sync(() => {
			process.stderr.write(`collector error: ${String(cause)}\n`);
			process.exitCode = 1;
		})
	),
	Effect.provide(platform)
));
