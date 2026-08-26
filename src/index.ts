/**
 * Composition root — the ONLY file that knows OpenCode.
 *
 * Current invariants (post AUDIT-027..044 remediation):
 *  - options decoded from unknown; invalid => logged defaults (explicit policy)
 *  - execute.before: location resolved BEFORE policy; intents carry paths;
 *    mutation targets are containment-checked (fail-closed on escape);
 *    pre-write snapshots captured per tool-call ID
 *  - execute.after: snapshots consumed and DELETED on every terminal outcome;
 *    changed spans computed via diffLines; kernel Feedback rule evaluates the
 *    actual projection; findings are appended to the completed Tool.Result
 *  - verification: peek -> verify -> persist(durable) -> drain-on-success;
 *    a failed run RETAINS the change ledger for retry
 *  - gate/header honor BOTH static config AND persisted per-project mode
 */
import { Clock, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Plugin } from '@opencode-ai/plugin/effect';
import { Tool } from '@opencode-ai/schema/tool';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

import { DEFAULT_ASSETS_ROOT as TS_MODULE_ASSETS } from '@opencode-effect-harness/module-typescript';

import { Decision } from 'opencode-harness-kit/Decision.ts';
import { Edit } from 'opencode-harness-kit/Edit.ts';
import { Intent } from 'opencode-harness-kit/Intent.ts';
import { Projection } from 'opencode-harness-kit/Projection.ts';
import { Input } from 'opencode-harness-kit/Input.ts';
import { Gate as GateRule } from 'opencode-harness-kit/rule/Gate.ts';
import { Header as HeaderRule } from 'opencode-harness-kit/rule/Header.ts';
import { Feedback as FeedbackRule } from 'opencode-harness-kit/rule/Feedback.ts';

import type { VerificationModule } from 'opencode-verify-kit/Module.ts';
import { Registry, skillEntriesFromAssets } from 'opencode-verify-kit/Module.ts';
import { Orchestrator } from 'opencode-verify-kit/Orchestrator.ts';
import {
	boundedFromReader,
	ChangeSetProvider
} from 'opencode-verify-kit/ChangeSet.ts';
import {
	decodeWorkerOutput,
	filterUnverifiedFindings,
	CriticFinding,
	CriticReport,
	CriticRequest
} from 'opencode-verify-kit/Critic.ts';
import { VerifierReport, VerifyRequest } from 'opencode-verify-kit/Report.ts';

import { Journal } from 'opencode-harness-shared/Journal.ts';
import { projectKeyOf } from 'opencode-harness-shared/Refs.ts';
import {
	partitionWithinRoot,
	withinRoot
} from 'opencode-harness-shared/PathGuard.ts';
import { realpath } from './RealPath.ts';

import {
	computeChangedSpans,
	extractAffectedPaths,
	resolveAffected
} from './Snapshots.ts';
import { decode, defaults as defaultOptions } from './Options.ts';
import { ExecNode } from './ExecNode.ts';
import { Sessions } from './Sessions.ts';
import { Origins } from './Origins.ts';
import { ModeState } from './ModeState.ts';
import { Ledger, PendingReads, type HostStorage } from './Ledger.ts';
import { ChangeLedger } from './ChangeLedger.ts';
import * as Events from './Events.ts';
import { LiveTraceSink } from './Events.ts';
import * as CapabilityModule from './Capability.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

interface SessionLocation {
	readonly directory: string;
	readonly projectKey: string;
}

/** Narrow destructive-shell signatures blocked pre-write for strict agents:
 *  fork bombs, mkfs/dd, hard git resets/cleans, chmod -R 777, relative-path
 *  rm/mv escapes, and rm of any flag combination targeting filesystem root. */
const DESTRUCTIVE_SHELL_RE =
	/\b(?::\(\)\s*\{\s*:\|:&\s*\};:|mkfs(?:\.\w+)?\b|dd\s+if=|git\s+reset\s+--hard\b|git\s+clean\s+-[a-zA-Z]*[fd]|chmod\s+-R\s+777\b|(?:rm|mv)\s+-[a-zA-Z]+\s+\.\.?(?:\/|$)|\brm\s+(?:-{1,2}[a-zA-Z-]+\s+)+\/(?:\s|$))/i;

const MUTATING_TOOLS: ReadonlyArray<string> = [
	'write',
	'edit',
	'multiedit',
	'apply_patch',
	'patch'
];

class ReportPersistError extends Schema.TaggedError<ReportPersistError>()(
	'ReportPersistError',
	{ reason: Schema.String }
) {}

const property = (value: unknown, key: PropertyKey): unknown =>
	value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;

/** Host input shapes -> neutral write intent. Unknown tools produce none. */
const intentFromInput = (input: unknown): IntentValue | undefined => {
	const rawPath = property(input, 'path') ?? property(input, 'filePath');
	const filePath = typeof rawPath === 'string' ? rawPath : undefined;

	const edits = property(input, 'edits');
	if (Array.isArray(edits)) {
		const replacements = edits.flatMap((edit) => {
			const oldText = property(edit, 'oldText');
			const newText = property(edit, 'newText');
			return typeof oldText === 'string' && typeof newText === 'string'
				? [{ oldText, newText }]
				: [];
		});
		if (replacements.length > 0) {
			return new Intent.EditFile({
				phase: 'before',
				...(filePath !== undefined ? { filePath } : {}),
				replacements
			});
		}
	}

	const candidates = [
		property(input, 'content'),
		property(input, 'newString'),
		property(input, 'newText')
	];
	const content = candidates.find(
		(c): c is string => typeof c === 'string' && c.length > 0
	);
	if (content !== undefined) {
		return new Intent.WriteFile({
			phase: 'before',
			...(filePath !== undefined ? { filePath } : {}),
			content
		});
	}
	return undefined;
};

/** Localized branded-id conversion for host session APIs (A42). */
const brand = <T>(): ((value: string) => T & string) =>
	(value: string): T & string => value as unknown as T & string;

export default Plugin.define({
	id: 'opencode.effect-harness',
	effect: (ctx) =>
		Effect.gen(function* () {
			const config = yield* Effect.orElseSucceed(decode(ctx.options), () => {
				console.error('[opencode-effect-harness] invalid options — applying defaults');
				return defaultOptions();
			});

			const assetsRoot =
				config.harness.assetsRoot ?? TS_MODULE_ASSETS.replace(/\/$/, '');

			const providePlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.provide(effect, platform);

			// Symlink-hardened containment (AUDIT-035): compare REAL paths and
			// read the REAL target. Unresolvable or escaping paths yield undefined.
			const realRootCache = new Map<string, string | undefined>();
			const realRoot = (directory: string): Effect.Effect<string | undefined> =>
				Effect.suspend(() => {
					if (realRootCache.has(directory)) {
						return Effect.succeed(realRootCache.get(directory));
					}
					return Effect.map(realpath(directory), (value) => {
						realRootCache.set(directory, value);
						return value;
					});
				});
			const containedTarget = (
				rootDirectory: string,
				absolutePath: string
			): Effect.Effect<string | undefined> =>
				Effect.gen(function* () {
					const rootReal = yield* realRoot(rootDirectory);
					if (rootReal === undefined) return undefined;
					const targetReal = yield* realpath(absolutePath);
					if (targetReal === undefined) return undefined;
					return withinRoot(rootReal, targetReal);
				});
			const changeSetProviderFor = (
				location: SessionLocation
			): ChangeSetProvider.Interface => ({
				fromPaths: (input) =>
					boundedFromReader(input, (absolutePath) =>
						Effect.flatMap(
							containedTarget(location.directory, absolutePath),
							(real) =>
								real === undefined
									? Effect.succeed(Option.none<string>())
									: Effect.map(readText(real), Option.fromUndefinedOr)
						)
					)
			});

			// ---- host-adjacent services ----
			const sessions = Sessions.make(
				ctx.session as unknown as Parameters<typeof Sessions.make>[0],
				brand()
			);
			const origins = Origins.make();
			const mode = ModeState.make(ctx.storage as HostStorage);
			const runsStorage = ctx.storage as HostStorage;
			const ledger = Ledger.make(ctx.storage as HostStorage);
			const pending = PendingReads.make();
			const changes = ChangeLedger.make();
			const traceSink = LiveTraceSink.make();

			// ---- kernel projection service ----
			const projectionLayer = Projection.layer.pipe(Layer.provide(platform));
			const projectionOf = <A>(
				use: (p: Projection.Interface) => Effect.Effect<A>
			): Effect.Effect<A> =>
				Projection.Service.use(use).pipe(Effect.provide(projectionLayer));

			const degradedIntentValue = (intent: IntentValue): Input.Value =>
				new Input.Value({
					filePath: Option.some(intent.filePath ?? ''),
					content: Option.none(),
					changedSpans: Option.none(),
					command: Option.none(),
					pattern: Option.none(),
					query: Option.none(),
					url: Option.none(),
					prompt: Option.none(),
					projectionError: 'projection-unavailable'
				});

			// ---- knowledge catalog loaded ONCE at startup (fail-visible) ----
			const patternList = yield* loadPatternsSafe(assetsRoot);
			console.error(
				`[opencode-effect-harness] pattern catalog loaded: ${String(patternList.length)} detectors from ${assetsRoot}`
			);

			// ---- verification runtime ----
			const exec = ExecNode.make();
			interface ModuleFactory {
				createModule: (options?: {
					readonly assetsRoot?: string;
				}) => Effect.Effect<VerificationModule, unknown, unknown>;
			}
			const loaders: Record<string, () => Promise<unknown>> = {
				typescript: (): Promise<unknown> => import('@opencode-effect-harness/module-typescript'),
				bend: (): Promise<unknown> => import('@opencode-effect-harness/module-bend')
			};
			const requestedIds = config.verify.moduleIds ?? ['typescript'];
			const moduleLoadFailures: Array<{ readonly moduleId: string; readonly reason: string }> = [];
			const loadedModules = yield* Effect.forEach(
				requestedIds,
				(id) =>
					Effect.gen(function* () {
						const loader = loaders[id];
						if (loader === undefined) {
							moduleLoadFailures.push({ moduleId: id, reason: 'unknown verification module' });
							console.error(`[opencode-effect-harness] unknown verification module: ${String(id)}`);
							return [] as ReadonlyArray<VerificationModule>;
						}
						const raw = yield* Effect.orElseSucceed(
							Effect.promise(loader),
							() => undefined
						);
						if (raw === undefined) {
							moduleLoadFailures.push({ moduleId: id, reason: 'module import failed' });
							console.error(`[opencode-effect-harness] module not installed: ${String(id)}`);
							return [] as ReadonlyArray<VerificationModule>;
						}
						const factory = (raw as Partial<ModuleFactory>).createModule;
						if (typeof factory !== 'function') {
							moduleLoadFailures.push({ moduleId: id, reason: 'missing createModule factory' });
							console.error(
								`[opencode-effect-harness] module '${String(id)}' exposes no createModule(options) factory`
							);
							return [] as ReadonlyArray<VerificationModule>;
						}
						// Uniform contract: createModule({assetsRoot}) -> Effect (AUDIT-034).
						// Forward an assetsRoot override ONLY when explicitly configured;
						// otherwise each module resolves its OWN bundled catalog.
						const moduleOptions =
							config.harness.assetsRoot !== undefined ? { assetsRoot } : {};
						const created = yield* factory(moduleOptions).pipe(
							providePlatform,
							Effect.orElseSucceed(() => undefined)
						);
						if (created === undefined) {
							moduleLoadFailures.push({ moduleId: id, reason: 'module construction failed' });
							console.error(
								`[opencode-effect-harness] module '${String(id)}' failed to construct (catalog error?)`
							);
							return [] as ReadonlyArray<VerificationModule>;
						}
						return [created];
					}),
				{ concurrency: 1 }
			);
			const registry = Registry.make(loadedModules.flat());

			// ---- append-only critic journal (lazy per-call provide) ----
			const journalLayer = Journal.layer('.effect-harness/journal').pipe(
				Layer.provide(platform)
			);
			const appendCriticEvent = (stream: string, kind: string, payload: unknown): Effect.Effect<void> =>
				Journal.Service.use((j: Journal.Interface) =>
					j.append({ stream, kind, payload, actor: 'critic' })
				).pipe(
					Effect.provide(journalLayer),
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							console.error('[opencode-effect-harness] critic journal append failed:', String(cause));
						})
					)
				);

			// ---- skill catalog + capability-probed native registration ----
			const skillEntries = yield* Effect.orElseSucceed(
				skillEntriesFromAssets({ assetsRoot }).pipe(Effect.provide(platform)),
				() => []
			);
			const prepared = yield* CapabilityModule.prepareAll(
				skillEntries,
				(entry) => readText(entry.skillFilePath).pipe(Effect.map((b) => b ?? ''))
			);
			if (prepared.infos.length === 0) {
				// AUDIT-028: zero skills is a LOUD degraded state — the strict gate
				// becomes unsatisfiable without native registration.
				console.error(
					`[opencode-effect-harness] FATAL: no effect-* skills found under ${assetsRoot}/skills — ` +
						'native skill registration skipped; set harness.assetsRoot or reinstall language modules.'
				);
			} else if (prepared.rejected > 0) {
				console.error(
					`[opencode-effect-harness] ${String(prepared.rejected)}/${String(prepared.infos.length + prepared.rejected)} skills rejected by pinned Skill.Info schema`
				);
			}

			yield* ctx.skill.transform((draft) => {
				const result = CapabilityModule.applyToDraft(
					draft as unknown as CapabilityModule.SkillDraftProbe,
					prepared.infos
				);
				if (!result.attempted || result.registered !== prepared.infos.length) {
					console.error('[opencode-effect-harness] skill registration:', result.reason ?? 'partial');
				}
			});

			// ---- registered tools ----
			yield* ctx.tool.transform((tools) => {
				tools.add({
					name: 'effect_harness_verify',
					description:
						'Deterministic checks + pattern findings + skill evidence (+ optional semantic review). Persists a JSON report under .effect-harness/reports.',
					input: {
						type: 'object',
						properties: {
							touchedFiles: { type: 'array', items: { type: 'string' } }
						},
						additionalProperties: false
					},
					execute: (rawInput: unknown, execCtx: { readonly sessionID: string }) =>
						Effect.gen(function* () {
							const location = yield* sessions.resolve(execCtx.sessionID).pipe(
								Effect.orElseSucceed(() => undefined)
							);
							if (location === undefined) {
								return yield* Effect.fail(
									new Tool.Error({ message: 'cannot resolve session location for verify' })
								);
							}
							const parsed = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as {
								touchedFiles?: ReadonlyArray<string>;
							};
							// Caller-supplied paths are containment-checked fail-closed.
							const requestedTouched = parsed.touchedFiles ?? [];
							const touchedPartition = partitionWithinRoot(
								location.directory,
								requestedTouched
							);
							if (touchedPartition.escaped.length > 0) {
								return yield* Effect.fail(
									new Tool.Error({
										message: `harness: touchedFiles escape project root (${touchedPartition.escaped.join(', ')})`
									})
								);
							}
							// peek -> verify -> persist -> drain-on-success (AUDIT-033):
							// a failed run RETAINS the ledger for retry.
							const pendingFiles = yield* changes.peek({
								projectKey: location.projectKey,
								sessionID: execCtx.sessionID
							});
							const touchedFiles = [...touchedPartition.contained, ...pendingFiles];
							const loadedNames = yield* ledger.loadedNames({
								projectKey: location.projectKey,
								sessionID: execCtx.sessionID
							});

							const request = new VerifyRequest({
								sessionID: execCtx.sessionID,
								projectKey: location.projectKey,
								projectRoot: location.directory,
								touchedFiles,
								trigger: 'manual',
								loadedSkills: [...loadedNames],
								minSkillEvidence: config.harness.minEffectSkills
							});

							const report = yield* Orchestrator.verify(
								{
									registry,
									exec,
									semanticRequired: config.verify.semanticReview,
									moduleLoadFailures,
									changeSetProvider: changeSetProviderFor(location),
									readFile: (absPath: string) =>
										Effect.flatMap(
											containedTarget(location.directory, absPath),
											(real) =>
												real === undefined
													? Effect.succeed(undefined)
													: readText(real)
										),
								},
								request
							);

							const now = yield* Clock.currentTimeMillis;
							const baseName = `${now.toString(36)}-${execCtx.sessionID.slice(-8)}`;
							const reportPath = yield* persistReport(location.directory, report, baseName).pipe(
								Effect.mapError(
									(e) =>
										new Tool.Error({
											message: `report persistence failed: ${e.reason}`
										})
								)
							);
							yield* changes.drain({
								projectKey: location.projectKey,
								sessionID: execCtx.sessionID
							});
							const passed = report.checks.filter((c) => c.verdict === 'passed').length;

							return {
								output: undefined,
								content:
									`verify ${report.overall}: ${String(passed)}/${String(report.checks.length)} checks passed` +
									(`\nreport: ${reportPath}`),
								metadata: { overall: report.overall, reportPath }
							} as never;
						})
				});

				tools.add({
					name: 'effect_harness_critic',
					description:
						'Independent read-only audit of builder reasoning. Decodes structured verdicts; returns explicit `unavailable` when the transcript cannot be observed.',
					input: {
						type: 'object',
						properties: {
							summary: { type: 'string', minLength: 10 },
							focus: {
								type: 'string',
								enum: ['feature', 'plan', 'architecture', 'drift', 'full']
							}
						},
						required: ['summary'],
						additionalProperties: false
					},
					execute: (rawInput: unknown, execCtx: { readonly sessionID: string }) =>
						Effect.gen(function* () {
							const parsed = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as {
								summary?: string;
								focus?: string;
							};
							const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
							if (summary.length < 10) {
								return yield* Effect.fail(
									new Tool.Error({ message: 'harness_critic requires a summary of >=10 chars.' })
								);
							}
							if (!config.critic.enabled) {
								return yield* Effect.fail(new Tool.Error({ message: 'critic disabled by configuration.' }));
							}
							// Independence POLICY is enforceable here: the restricted plugin
							// context cannot compare builder/critic models, so requiring it
							// must FAIL instead of completing with a note.
							if (config.critic.requireIndependentModel) {
								return yield* Effect.fail(
									new Tool.Error({
										message:
											'critic: requireIndependentModel is enabled but model comparison is impossible in-plugin. Disable it or use the companion critic.'
									})
								);
							}

							const focus = parsed.focus ?? 'full';
							const builderLocation = yield* sessions.resolve(execCtx.sessionID).pipe(
								Effect.orElseSucceed(() => undefined)
							);
							if (builderLocation === undefined) {
								return yield* Effect.fail(
									new Tool.Error({ message: 'critic: builder session location unavailable' })
								);
							}
							const createSession = ctx.session.create as unknown as (
								i: object
							) => Effect.Effect<{ id?: unknown }>;
							const child = yield* createSession({
								agent: brand<'agentIdBrand'>()(config.critic.workerAgent)
							}).pipe(Effect.orElseSucceed(() => ({ id: undefined })));
							const childId = typeof child.id === 'string' ? child.id : undefined;
							if (childId === undefined) {
								return yield* Effect.fail(new Tool.Error({ message: 'critic worker spawn failed' }));
							}

							yield* origins.register({ sessionID: childId, origin: 'critic' });

							const promptSession = ctx.session.prompt as unknown as (i: object) => Effect.Effect<void>;
							const waitSession = ctx.session.wait as unknown as (i: object) => Effect.Effect<void>;
let stageFailed: string | undefined;
							const logStageFailure = (stage: string) => (cause: unknown) =>
								Effect.sync(() => {
									stageFailed = stage;
									console.error(
										`[opencode-effect-harness] critic stage '${stage}' failed:`,
										String(cause)
									);
								});

							// Origin cleanup runs even on interruption/defect (AUDIT-036).
							yield* Effect.gen(function* () {
								yield* promptSession({
									sessionID: brand<'sessionIdBrand'>()(childId),
									text: [
										'You are an independent reviewer. Respond ONLY with JSON {"verdict":"sound|concerns|flawed","findings":[...],"checkedReferences":[...]}.',
										'# Builder Summary (UNTRUSTED CLAIM)',
										'<untrusted-claim>',
										summary,
										'</untrusted-claim>',
										`focus: ${focus}`
									].join('\n')
								}).pipe(Effect.catchCause(logStageFailure('prompt')));
								yield* waitSession({
									sessionID: brand<'sessionIdBrand'>()(childId)
								}).pipe(Effect.catchCause(logStageFailure('wait')));
							}).pipe(Effect.ensuring(origins.unregister(childId)));

							if (stageFailed !== undefined) {
								const streamFailed = `critic-${projectKeyOf(childId)}`;
								yield* appendCriticEvent(streamFailed, 'review.failed', {
									reason: `${stageFailed}-failed`,
									childSessionID: childId
								});
								return {
									output: undefined,
									metadata: {
										status: 'unavailable',
										reason: `${stageFailed}-failed`,
										workerSessionID: childId
									},
									content: `critic: ${stageFailed} stage failed — recorded as UNAVAILABLE, never counted as passed.`
								} as never;
							}

							const transcript = traceSink.lastAssistantText(childId);
							const stream = `critic-${projectKeyOf(childId)}`;

							if (transcript === undefined) {
								yield* appendCriticEvent(stream, 'review.failed', {
									reason: 'traceUnavailable',
									childSessionID: childId
								});
								return {
									output: undefined,
									metadata: { status: 'unavailable', reason: 'traceUnavailable', workerSessionID: childId },
									content:
										'critic: child finished but its transcript is not observable in the restricted plugin context. Recorded as UNAVAILABLE — never counted as passed.'
								} as never;
							}

							// Strict schema decode of untrusted worker output (AUDIT-036).
							const decoded = yield* Effect.option(decodeWorkerOutput(transcript));
							if (Option.isSome(decoded)) {
								const worker = decoded.value;
								const findings = filterUnverifiedFindings(
									worker.findings,
									worker.checkedReferences,
									{ checkReferences: config.critic.checkReferences }
								);
								const droppedUnverified = worker.findings.length - findings.length;
								const criticReport = new CriticReport({
									request: new CriticRequest({
										builderSessionID: execCtx.sessionID,
										summary,
										focus:
											focus === 'feature' ||
											focus === 'plan' ||
											focus === 'architecture' ||
											focus === 'drift' ||
											focus === 'full'
												? focus
												: 'full',
										explicit: true,
										traceRefs: []
									}),
									verdict: worker.verdict,
									findings: findings.map(
										(finding, index) =>
											new CriticFinding({
												id: `${childId}-${String(index + 1)}`,
												severity: finding.severity,
												kind: finding.kind,
												claim: finding.claim,
												evidence: finding.evidence,
												...(finding.suggestion !== undefined
													? { suggestion: finding.suggestion }
													: {})
											})
									),
									checkedReferences: worker.checkedReferences,
									workerSessionID: childId,
									completedAt: yield* Clock.currentTimeMillis
								});
								const criticReportPath = yield* persistCriticReport(
									builderLocation.directory,
									criticReport,
									childId
								).pipe(
									Effect.mapError(
										(e) => new Tool.Error({ message: `critic report persistence failed: ${e.reason}` })
									)
								);
								// Builder model is unknowable in the restricted plugin context,
								// so model independence can never be PROVEN here (honest note).
								const independenceProvable = !config.critic.requireIndependentModel;

								yield* appendCriticEvent(stream, 'review.completed', {
									childSessionID: childId,
									verdict: worker.verdict,
									findings,
									checkedReferences: worker.checkedReferences,
									artifact: criticReportPath,
									droppedUnverified,
									independenceProvable
								});

								const sections = findings.map(
									(f, idx) =>
										`${String(idx + 1)}. [${f.severity}/${f.kind}] ${f.claim}\n   evidence: ${f.evidence}${
											f.suggestion === undefined ? '' : `\n   suggestion: ${f.suggestion}`
										}`
								);
								const header = [
									`critic verdict: ${worker.verdict}`,
									`findings: ${String(findings.length)}${
										droppedUnverified > 0
											? ` (${String(droppedUnverified)} dropped: cited references not opened)`
											: ''
									}`,
									...(independenceProvable
										? []
										: ['note: requireIndependentModel is on, but builder/critic models cannot be compared in-plugin — independence UNPROVEN'])
								].join('\n');
								return {
									output: undefined,
									metadata: {
										status: 'completed',
										decoded: true,
										verdict: worker.verdict,
										findings: findings.length,
										workerSessionID: childId
									},
									content:
										header +
										(sections.length > 0
											? `\n\n${sections.join('\n\n')}\n\nreferences opened: ${String(worker.checkedReferences.length)}`
											: '') +
										`\nreport: ${criticReportPath}`
								} as never;
							}

							// Undecodable output is reported AS undecoded — never relabeled.
							yield* appendCriticEvent(stream, 'review.completed', {
								childSessionID: childId,
								decoded: false,
								preview: transcript.slice(0, 2000)
							});
							return {
								output: undefined,
								metadata: { status: 'completed', decoded: false, workerSessionID: childId },
								content:
									'critic: worker output did not match the required JSON contract (raw transcript below). Treat as UNVERIFIED.\n\n' +
									transcript.slice(0, 4000)
							} as never;
						})
				});

				tools.add({
					name: 'harness_skill_stats',
					description: 'Show loaded effect-* skills for this session.',
					input: { type: 'object', properties: {}, additionalProperties: false },
					execute: (_raw: unknown, execCtx: { readonly sessionID: string }) =>
						Effect.gen(function* () {
							const location = yield* sessions.resolve(execCtx.sessionID).pipe(
								Effect.orElseSucceed(() => undefined)
							);
							const names =
								location === undefined
									? []
									: yield* ledger.loadedNames({
										projectKey: location.projectKey,
										sessionID: execCtx.sessionID
									  });
							return {
								output: undefined,
								content: `loaded effect-* skills (${String(names.length)}): ${names.join(', ') || '(none)'}`
							} as never;
						})
				});

				tools.add({
					name: 'harness_toggle',
					description: 'Toggle harness mode (per-project, persisted; telemetry keeps running).',
					input: {
						type: 'object',
						properties: { enabled: { type: 'boolean' } },
						additionalProperties: false
					},
					execute: (rawInput: unknown, execCtx: { readonly sessionID: string }) =>
						Effect.gen(function* () {
							const location = yield* sessions.resolve(execCtx.sessionID).pipe(
								Effect.orElseSucceed(() => undefined)
							);
							if (location === undefined) {
								return yield* Effect.fail(new Tool.Error({ message: 'cannot resolve session location' }));
							}
							const parsed = (typeof rawInput === 'object' && rawInput !== null ? rawInput : {}) as {
								enabled?: boolean;
							};
							const current = yield* mode.enabled(location.projectKey);
							const desired = parsed.enabled ?? !current;
							const saved = yield* mode.set({ projectKey: location.projectKey, enabled: desired }).pipe(
								Effect.mapError((e) =>
									new Tool.Error({ message: `mode persistence failed: ${e.reason}` })
								)
							);
							return {
								output: undefined,
								content: `harness mode ${saved ? 'enabled' : 'disabled'}`
							} as never;
						})
				});

				tools.add({
					name: 'effect_harness_compound',
					description: 'Blueprint benchmark execution (REM-4): NOT wired yet.',
					input: {
						type: 'object',
						properties: {
							blueprintId: { type: 'string' },
							modelIds: { type: 'array', items: { type: 'string' } }
						},
						required: ['blueprintId'],
						additionalProperties: false
					},
					execute: (rawInput: unknown) =>
						Effect.gen(function* () {
							if (!config.compound.enabled) {
								return yield* Effect.fail(
									new Tool.Error({ message: 'compound disabled by configuration. Set compound.enabled: true.' })
								)
							}
							// Honest stub (AUDIT-037): no fake queueing until REM-4 lands.
							return yield* Effect.fail(
								new Tool.Error({
									message:
										'compound benchmark execution is not implemented yet (REM-4 pending). Nothing was queued or persisted.'
								})
							);
						})
				});
			});

			// ---- hooks ----
			const denyInternalMutation = (toolName: string, sessionId: string) =>
				Effect.gen(function* () {
					const origin = yield* origins.originOf(sessionId);
					if (origin === undefined || config.harness.allowEdits) return;
					if (origins.isMutationTool(toolName)) {
						return yield* Effect.fail(
							new Tool.Error({ message: `internal ${origin} session is read-only` })
						);
					}
				});

			const effectiveEnabled = (location: SessionLocation | undefined) =>
				Effect.gen(function* () {
					if (!config.harness.enabled) return false;
					if (location === undefined) return true;
					return yield* mode.enabled(location.projectKey);
				});

			const pendingCountFor = (
				location: SessionLocation,
				sessionId: string
			): Effect.Effect<number> =>
				Effect.flatMap(
					pending.names({ projectKey: location.projectKey, sessionID: sessionId }),
					(names) =>
						ledger.countDistinct({
							projectKey: location.projectKey,
							sessionID: sessionId,
							pending: names
						})
				);

			// Per-event rule instance: scope travels with the RESOLVED location,
			// never through process-global mutable state (AUDIT-030).
			const makeGateRule = (location: SessionLocation) =>
				GateRule.rule({
					min: config.harness.minEffectSkills,
					strictAgents: config.harness.strictAgents,
					failClosed: config.harness.failClosedForGate,
					reason: (loadedCount) =>
						Effect.succeed(
							`harness gate: this write introduces Effect code.\n` +
								`Loaded effect-* skills: ${String(loadedCount)}/${String(config.harness.minEffectSkills)}.\n` +
								'Read relevant effect-* skill files (or use effect skill search), then retry.'
						),
					loaded: (sessionId) => pendingCountFor(location, sessionId ?? ''),
					project: (cwd, intent) =>
						projectionOf((p) => p.prospective(cwd, intent)).pipe(
							Effect.catchCause(() => Effect.succeed(degradedIntentValue(intent)))
						)
				});

			const evaluateGate = (input: {
				readonly agent: string;
				readonly sessionId: string;
				readonly location: SessionLocation;
				readonly writeIntent: IntentValue;
			}): Effect.Effect<ReadonlyArray<DecisionValue>> =>
				Effect.gen(function* () {
					const enabled = yield* effectiveEnabled(input.location);
					if (!enabled) return [];
					const strict = config.harness.strictAgents.includes(input.agent);
					if (!strict) return [];
					return yield* makeGateRule(input.location).evaluate({
						activeBranch: { entries: [] },
						cwd: input.location.directory,
						agent: input.agent,
						sessionId: input.sessionId,
						writeIntent: input.writeIntent
					} as never);
				}).pipe(
					// Infrastructure failure must respect fail-closed policy (AUDIT-041)
					// instead of collapsing into "allowed".
					Effect.catchCause(() =>
						config.harness.failClosedForGate
							? Effect.succeed([
									new Decision.BlockToolCall({
										reason:
											'harness gate: evaluation failed (fail-closed). Retry; if persistent, disable harness mode for this project.'
									})
								])
							: Effect.succeed([] as ReadonlyArray<DecisionValue>)
					)
				);

			const headerRule = HeaderRule.rule({
				header: guidanceHeader(assetsRoot),
				enabled: Effect.succeed(true)
			});

			// ---- pre-write snapshot store keyed by call ID (AUDIT-027) ----
			interface PendingWriteSnapshot {
				readonly directory: string;
				readonly files: ReadonlyArray<{
					readonly filePath: string;
					readonly absolutePath: string;
					readonly beforeContent: string | undefined;
				}>;
			}
			const pendingSnapshots = new Map<string, PendingWriteSnapshot>();
			const snapshotKey = (sessionID: string, callID: string): string =>
				`${sessionID}:${callID}`;

			yield* ctx.tool.hook('execute.before', (event) =>
				Effect.gen(function* () {
					const sessionId = String(event.sessionID);
					yield* denyInternalMutation(event.tool, sessionId);

					// Shell tools: narrow DESTRUCTIVE signatures blocked pre-write for
					// strict agents; other shell writes stay post-write-monitored
					// (documented limitation, AUDIT-029).
					if (event.tool === 'bash' || event.tool === 'shell') {
						const commandText = String(
							property(event.input, 'command') ??
								property(event.input, 'script') ??
								''
						);
						const hit = DESTRUCTIVE_SHELL_RE.exec(commandText);
						if (hit !== null) {
							const loc = yield* sessions.resolve(sessionId).pipe(
								Effect.orElseSucceed(() => undefined)
							);
							const enabled = yield* effectiveEnabled(loc);
							if (
								enabled &&
								config.harness.strictAgents.includes(String(event.agent))
							) {
								return yield* Effect.fail(
									new Tool.Error({
										message: `harness: destructive shell command blocked for strict agent: ${hit[0].trim()}`
									})
								);
							}
						}
						return;
					}

					if (event.tool === 'read') {
						const path = property(event.input, 'path');
						if (typeof path === 'string') {
							const location = yield* sessions.resolve(sessionId).pipe(
								Effect.orElseSucceed(() => undefined)
							);
							const matched =
								location === undefined
									? undefined
									: yield* matchSkill(path, assetsRoot).pipe(Effect.orElseSucceed(() => undefined));
							if (location !== undefined && matched !== undefined) {
								yield* pending.remember({
									projectKey: location.projectKey,
									sessionID: sessionId,
									callId: String(event.id),
									skill: matched
								});
							}
						}
						return;
					}

					if (!MUTATING_TOOLS.includes(event.tool)) return;

					const location = yield* sessions.resolve(sessionId).pipe(
						Effect.orElseSucceed(() => undefined)
					);
					if (location === undefined) {
						if (config.harness.failClosedForGate) {
							return yield* Effect.fail(
								new Tool.Error({
									message: 'harness gate: cannot resolve session location (fail-closed)'
								})
							);
						}
						return;
					}

					const patchTool = event.tool === 'apply_patch' || event.tool === 'patch';
					const patchText = String(
						property(event.input, 'patchText') ?? property(event.input, 'patch') ?? ''
					);
					const affected = extractAffectedPaths(event.tool, event.input);
					const enabledForPatch = yield* effectiveEnabled(location);
					if (
						patchTool &&
						(affected.length === 0 || patchText.length === 0) &&
						config.harness.strictAgents.includes(String(event.agent)) &&
						enabledForPatch
					) {
						return yield* Effect.fail(
							new Tool.Error({
								message: 'harness: unparseable patch blocked for strict agent'
							})
						);
					}
					const regularIntent = intentFromInput(event.input);
					const intents = patchTool
						? affected.map(
								(filePath) =>
									new Intent.WriteFile({
										phase: 'before',
										filePath,
										content: patchText.slice(0, 200_000)
									})
							)
						: regularIntent === undefined
							? []
							: [regularIntent];
					yield* Effect.forEach(
						intents,
						(intent) =>
							Effect.gen(function* () {
								const decisions = yield* evaluateGate({
									agent: String(event.agent),
									sessionId,
									location,
									writeIntent: intent
								});
								const blocked = decisions.find(
									(d): d is Extract<typeof d, { _tag: 'BlockToolCall' }> =>
										d._tag === 'BlockToolCall'
								);
								if (blocked !== undefined) {
									return yield* Effect.fail(new Tool.Error({ message: blocked.reason }));
								}
							}),
						{ concurrency: 1, discard: true }
					);


					// Pre-write snapshot capture with containment enforcement.
					if (affected.length === 0) return;
					const { snapshots, escaped } = resolveAffected(location.directory, affected);
					if (escaped.length > 0) {
						return yield* Effect.fail(
							new Tool.Error({
								message: `harness: target escapes project root (${escaped.join(', ')})`
							})
						);
					}
					const nestedFiles = yield* Effect.forEach(
						snapshots,
						(snap) =>
							Effect.gen(function* () {
								const real = yield* containedTarget(
									location.directory,
									snap.absolutePath
								);
								if (real === undefined) return [];
								const beforeContent = yield* readText(real);
								return [
									{
										filePath: snap.filePath,
											absolutePath: real,
											beforeContent
										}
									];
							}),
						{ concurrency: 4 }
					);
					const files = nestedFiles.flat();
					if (files.length === 0) return;
			pendingSnapshots.set(snapshotKey(sessionId, String(event.id)), {
						directory: location.directory,
						files
					});
				})
			);

			/** Append advisory text to the completed tool result (string | parts). */
			const appendResultContent = (result: unknown, text: string): void => {
				if (result === null || typeof result !== 'object') return;
				const record = result as { content?: string | Array<unknown> };
				if (typeof record.content === 'string') {
					record.content = `${record.content}\n\n${text}`;
					return;
				}
				if (Array.isArray(record.content)) {
					record.content = [...record.content, { type: 'text', text }];
					return;
				}
				record.content = text;
			};

			yield* ctx.tool.hook('execute.after', (event) =>
				Effect.gen(function* () {
					const callId = String(event.id);
					const sessionId = String(event.sessionID);

					// Terminal cleanup FIRST: failed/interrupted calls release their
					// snapshot too — full file contents are never retained (AUDIT-027).
					const snapshot = pendingSnapshots.get(snapshotKey(sessionId, callId));
					pendingSnapshots.delete(snapshotKey(sessionId, callId));

					if (event.tool === 'read') {
						const location = yield* sessions.resolve(sessionId).pipe(
							Effect.orElseSucceed(() => undefined)
						);
						if (location === undefined) return;
						const taken = yield* pending.take({
							projectKey: location.projectKey,
							sessionID: sessionId,
							callId
						});
						if (taken !== undefined && event.status === 'completed') {
							yield* ledger.mark({
								projectKey: location.projectKey,
								sessionID: sessionId,
								skill: taken
							});
						}
						return;
					}

					if (!MUTATING_TOOLS.includes(event.tool)) return;
					if (event.status !== 'completed') return;

					const location = yield* sessions.resolve(sessionId).pipe(
						Effect.orElseSucceed(() => undefined)
					);
					if (location === undefined) return;

					// Persisted toggle disables post-write monitoring too (AUDIT-041).
					const enabledNow = yield* effectiveEnabled(location);
					if (!enabledNow) return;

					// Change-ledger recording covers EVERY affected path, including
					// patch-text paths (AUDIT-029). Escapes are dropped loudly here;
					// containment was already fail-closed in execute.before.
					const affectedAll = extractAffectedPaths(event.tool, event.input);
					const { contained: affectedPaths } = partitionWithinRoot(
						location.directory,
						affectedAll
					);
					yield* Effect.forEach(
						affectedPaths,
						(filePath) =>
							changes.record({
								projectKey: location.projectKey,
								sessionID: sessionId,
								filePath
							}),
						{ concurrency: 4, discard: true }
					);

					// Post-write feedback: diff spans + kernel Feedback rule + inline
					// result mutation. Advisory only — failures never break the tool.
					yield* Effect.gen(function* () {
						if (snapshot === undefined || snapshot.files.length === 0) return;
						const messages: Array<string> = [];

						yield* Effect.forEach(
							snapshot.files,
							(file) =>
								Effect.gen(function* () {
									const afterContent = yield* readText(file.absolutePath);
									if (afterContent === undefined) return;
									const spans = computeChangedSpans(file.beforeContent, afterContent);
									if (spans.length === 0) return;

									const projection = new Input.Value({
										filePath: Option.some(file.filePath),
										content: Option.some(afterContent),
										changedSpans: Option.some(
											spans.map((s) => new Edit.Span({ start: s.start, end: s.end }))
										),
										command: Option.none(),
										pattern: Option.none(),
										query: Option.none(),
										url: Option.none(),
										prompt: Option.none()
									});
									const rule = FeedbackRule.rule({
										patterns: Effect.succeed(patternList),
										actual: () => Effect.succeed(projection)
									});
									const decisions = yield* rule.evaluate({
										activeBranch: { entries: [] } as never,
										toolName: event.tool as 'write' | 'edit',
										cwd: snapshot.directory,
										writeIntent:
											intentFromInput(event.input) ??
											new Intent.WriteFile({
												phase: 'after',
												filePath: file.filePath,
												content: ''
											})
									});
									decisions.forEach((decision) => {
										if (decision._tag === 'InjectUserMessage') {
											messages.push(decision.message.content);
										}
									});
								}),
							{ concurrency: 2, discard: true }
						);

						if (messages.length === 0) return;
						appendResultContent(
							(event as { result?: unknown }).result,
							messages.slice(0, Math.max(1, config.verify.maxFindings)).join('\n\n')
						);
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.sync(() => {
								console.error('[opencode-effect-harness] feedback scan failed:', String(cause));
							})
						)
					);
				})
			);

			yield* ctx.session.hook('context', (sessionContext) =>
				Effect.gen(function* () {
					const sessionId = String(sessionContext.sessionID);
					yield* origins.restrictTools({
						sessionID: sessionId,
						allowEdits: config.harness.allowEdits,
						tools: sessionContext.tools as Record<string, unknown>
					});

					const blueprintPrompt = yield* origins.promptFor(sessionId);
					if (blueprintPrompt !== undefined) {
						sessionContext.system.push({ type: 'text', text: blueprintPrompt });
					}

					const location = yield* sessions.resolve(sessionId).pipe(
						Effect.orElseSucceed(() => undefined)
					);
					const enabledNow = yield* effectiveEnabled(location);
					if (!enabledNow) return;

					const decisions = yield* headerRule.evaluate({
						activeBranch: { entries: [] } as never,
						cwd: location?.directory ?? process.cwd()
					});
					decisions.forEach((decision) => {
						if (decision._tag === 'InjectSystemPrompt') {
							sessionContext.system.push({ type: 'text', text: decision.content });
						}
					});
				}).pipe(Effect.ignore)
			);

			// ---- one supervised consumer: telemetry + trace sink + auto-verify ----
			const stream = ctx.event.subscribe() as unknown as import('effect').Stream.Stream<
				Events.HostEvent,
				never
			>;
			const inFlight = new Set<string>();
			yield* Events.consumeAll(stream, {
				onAnyEvent: (event) => LiveTraceSink.feed(traceSink, event),
				onSkillActivated: (activated) =>
					Effect.gen(function* () {
						const location = yield* sessions.resolve(activated.sessionID).pipe(
							Effect.orElseSucceed(() => undefined)
						);
						if (location === undefined) return;
						yield* ledger.mark({
							projectKey: location.projectKey,
							sessionID: activated.sessionID,
							skill: activated.name
						});
					}),
				onCompacted: (compacted) =>
					Effect.gen(function* () {
						const location = yield* sessions.resolve(compacted.sessionID).pipe(
							Effect.orElseSucceed(() => undefined)
						);
						if (location === undefined) return;
						yield* ledger.reset({
							projectKey: location.projectKey,
							sessionID: compacted.sessionID
						});
					}),
				onExecutionEnded: (ended) =>
					Effect.gen(function* () {
						LiveTraceSink.feed(traceSink, {
							type: `execution.${ended.outcome}`,
							properties: { sessionID: ended.sessionID }
						});
						if (ended.outcome !== 'succeeded' || config.verify.trigger !== 'auto') return;
						const origin = yield* origins.originOf(ended.sessionID);
						if (origin !== undefined) return;
						const location = yield* sessions.resolve(ended.sessionID).pipe(
							Effect.orElseSucceed(() => undefined)
						);
						if (location === undefined) return;
						const idempotencyKey = `${location.projectKey}:${ended.sessionID}`;
						if (inFlight.has(idempotencyKey)) return;
						inFlight.add(idempotencyKey);

						// Durable dedupe (AUDIT-033): last SUCCESSFULLY processed host
						// event id survives restarts; replays never re-verify.
						const runsKey = `opencode-effect-harness/runs/${location.projectKey}/${ended.sessionID}`;
						const storedRunIds = yield* runsStorage.get(runsKey).pipe(
							Effect.orElseSucceed(() => undefined)
						);
						const processedRunIds = Array.isArray(storedRunIds)
							? storedRunIds.filter((value): value is string => typeof value === 'string')
							: typeof storedRunIds === 'string'
								? [storedRunIds]
								: [];
						if (ended.eventId !== undefined && processedRunIds.includes(ended.eventId)) {
							return;
						}

						yield* Effect.gen(function* () {
							// peek -> verify -> persist -> drain-on-success (AUDIT-033).
							const files = yield* changes.peek({
								projectKey: location.projectKey,
								sessionID: ended.sessionID
							});
							if (files.length === 0) return;
							const loadedNames = yield* ledger.loadedNames({
								projectKey: location.projectKey,
								sessionID: ended.sessionID
							});
							const request = new VerifyRequest({
								sessionID: ended.sessionID,
								projectKey: location.projectKey,
								projectRoot: location.directory,
								touchedFiles: files,
								trigger: 'auto',
								loadedSkills: [...loadedNames],
								minSkillEvidence: config.harness.minEffectSkills
							});
							const report = yield* Orchestrator.verify(
								{
									registry,
									exec,
									semanticRequired: config.verify.semanticReview,
									moduleLoadFailures,
									changeSetProvider: changeSetProviderFor(location),
									readFile: (absPath: string) =>
										Effect.flatMap(
											containedTarget(location.directory, absPath),
											(real) =>
												real === undefined
													? Effect.succeed(undefined)
													: readText(real)
										),
								},
								request
							);
							const baseName =
								ended.eventId ??
								(yield* Clock.currentTimeMillis).toString(36);
							const reportPath = yield* persistReport(location.directory, report, baseName);
							console.error(
								`[opencode-effect-harness] auto-verify ${report.overall}: ${reportPath}`
							);
							yield* changes.drain({
								projectKey: location.projectKey,
								sessionID: ended.sessionID
							});
							if (ended.eventId !== undefined) {
								yield* runsStorage.set(runsKey, [ended.eventId, ...processedRunIds].slice(0, 64)).pipe(
									Effect.ignore
								);
							}
						}).pipe(
							// Failures KEEP the change ledger so the next trigger retries.
							Effect.catchCause((cause) =>
								Effect.sync(() => {
									console.error('[opencode-effect-harness] auto-verify failed (changes retained):', String(cause));
								})
							),
							Effect.ensuring(Effect.sync(() => inFlight.delete(idempotencyKey)))
						);
					})
			}).pipe(Effect.forkScoped);
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					console.error('[opencode-effect-harness] setup failed:', String(cause));
				})
			)
		)
});

// ---------------------------------------------------------------------------
// Small FileSystem adapters (platform provided at each call)
// ---------------------------------------------------------------------------

const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const readText = (absPath: string): Effect.Effect<string | undefined> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const option = yield* fs.readFileString(absPath).pipe(Effect.option);
		return Option.isSome(option) ? option.value : undefined;
	}).pipe(Effect.provide(platformLayer));

const loadPatternsSafe = (
	assetsRoot: string
): Effect.Effect<ReadonlyArray<import('opencode-harness-kit/Pattern.ts').Pattern.Value>> =>
	Effect.flatMap(
		Effect.promise(() => import('opencode-harness-kit/Catalog.ts')),
		(catalog) =>
			catalog.loadPatterns(`${assetsRoot}/patterns`).pipe(
				Effect.catchTag('CatalogError', (error) => {
					console.error(
						`[opencode-effect-harness] pattern catalog unavailable at ${assetsRoot}: ${error.reason}`
					);
					return Effect.succeed([]) as Effect.Effect<
						ReadonlyArray<import('opencode-harness-kit/Pattern.ts').Pattern.Value>,
						never
					>;
				}),
				Effect.provide(platformLayer)
			)
	);

const matchSkill = (
	path: string,
	assetsRoot: string
): Effect.Effect<string | undefined> =>
	Effect.map(
		Effect.orElseSucceed(
			skillEntriesFromAssets({ assetsRoot }).pipe(Effect.provide(platformLayer)),
			() => [] as ReadonlyArray<{ name: string; skillFilePath: string }>
		),
		(entries) =>
			entries
				.filter((entry) =>
					path.startsWith(entry.skillFilePath.slice(0, entry.skillFilePath.lastIndexOf('/')))
				)
				.map((entry) => entry.name)
				.at(0)
	);

/**
 * Durable report persistence (AUDIT-033): creates the reports directory,
 * writes atomically via tmp+rename, encodes through the report schema, and
 * FAILS with a typed error instead of returning a phantom path.
 */
const persistReport = (
	projectRoot: string,
	report: VerifierReport,
	baseName: string
): Effect.Effect<string, ReportPersistError> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = `${projectRoot}/.effect-harness/reports`;
		yield* fs.makeDirectory(dir, { recursive: true }).pipe(
			Effect.catchTag(
				'PlatformError',
				() =>
					Effect.fail(
						new ReportPersistError({ reason: `cannot create ${dir}` })
					)
			)
		);
		const safeBase = baseName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'run';
		const target = `${dir}/${safeBase}-verify.json`;
		const tmp = `${target}.tmp`;
		const encoded = Schema.encodeSync(VerifierReport)(report);
		yield* fs.writeFileString(tmp, JSON.stringify(encoded, null, 2)).pipe(
			Effect.catchTag(
				'PlatformError',
				() =>
					Effect.fail(new ReportPersistError({ reason: `cannot write ${tmp}` }))
			)
		);
		yield* fs.rename(tmp, target).pipe(
			Effect.catchTag(
				'PlatformError',
				() =>
					Effect.fail(new ReportPersistError({ reason: `cannot finalize ${target}` }))
			)
		);
		return target;
	}).pipe(Effect.provide(platformLayer));

/** Persist the complete critic result as a separate auditable artifact. */
const persistCriticReport = (
	projectRoot: string,
	report: CriticReport,
	baseName: string
): Effect.Effect<string, ReportPersistError> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = `${projectRoot}/.effect-harness/critic-reports`;
		yield* fs.makeDirectory(dir, { recursive: true }).pipe(
			Effect.catchTag('PlatformError', () =>
				Effect.fail(new ReportPersistError({ reason: `cannot create ${dir}` }))
			)
		);
		const safeBase = baseName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'critic';
		const target = `${dir}/${safeBase}-critic.json`;
		const tmp = `${target}.tmp`;
		const encoded = Schema.encodeSync(CriticReport)(report);
		yield* fs.writeFileString(tmp, JSON.stringify(encoded, null, 2)).pipe(
			Effect.catchTag('PlatformError', () =>
				Effect.fail(new ReportPersistError({ reason: `cannot write ${tmp}` }))
			)
		);
		yield* fs.rename(tmp, target).pipe(
			Effect.catchTag('PlatformError', () =>
				Effect.fail(new ReportPersistError({ reason: `cannot finalize ${target}` }))
			)
		);
		return target;
	}).pipe(Effect.provide(platformLayer));

const guidanceHeader = (assetsRoot: string): Effect.Effect<string> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = `${assetsRoot}/guidance`;
		const names = yield* fs.readDirectory(dir).pipe(
			Effect.catchTag('PlatformError', () => Effect.succeed([] as ReadonlyArray<string>))
		);
		const bodies = yield* Effect.forEach(
			names.filter((n) => n.endsWith('.md')),
			(name) =>
				fs.readFileString(`${dir}/${name}`).pipe(
					Effect.catchTag('PlatformError', () => Effect.succeed(''))
				),
			{ concurrency: 8 }
		);
		return bodies.join('');
	}).pipe(Effect.provide(platformLayer));
