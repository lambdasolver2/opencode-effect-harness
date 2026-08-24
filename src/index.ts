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
import { VerifierReport, VerifyRequest } from 'opencode-verify-kit/Report.ts';

import { Journal } from 'opencode-harness-shared/Journal.ts';

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

/** Tools whose successful completion is monitored post-write. */
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

			// ---- host-adjacent services ----
			const sessions = Sessions.make(
				ctx.session as unknown as Parameters<typeof Sessions.make>[0],
				brand()
			);
			const origins = Origins.make();
			const mode = ModeState.make(ctx.storage as HostStorage);
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
			const loadedModules = yield* Effect.forEach(
				requestedIds,
				(id) =>
					Effect.gen(function* () {
						const loader = loaders[id];
						if (loader === undefined) {
							console.error(`[opencode-effect-harness] unknown verification module: ${String(id)}`);
							return [] as ReadonlyArray<VerificationModule>;
						}
						const raw = yield* Effect.orElseSucceed(
							Effect.promise(loader),
							() => undefined
						);
						if (raw === undefined) {
							console.error(`[opencode-effect-harness] module not installed: ${String(id)}`);
							return [] as ReadonlyArray<VerificationModule>;
						}
						const factory = (raw as Partial<ModuleFactory>).createModule;
						if (typeof factory !== 'function') {
							console.error(
								`[opencode-effect-harness] module '${String(id)}' exposes no createModule(options) factory`
							);
							return [] as ReadonlyArray<VerificationModule>;
						}
						// Uniform contract: createModule({assetsRoot}) -> Effect (AUDIT-034).
						const created = yield* factory({ assetsRoot }).pipe(
							providePlatform,
							Effect.orElseSucceed(() => undefined)
						);
						if (created === undefined) {
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
				).pipe(Effect.provide(journalLayer), Effect.ignore);

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

			yield* ctx.tool.hook('execute.before', (event) =>
				Effect.gen(function* () {
					const sessionId = String(event.sessionID);
					yield* denyInternalMutation(event.tool, sessionId);

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

					const intent = intentFromInput(event.input);
					if (intent === undefined) return;

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

					// Pre-write snapshot capture with containment enforcement.
					const affected = extractAffectedPaths(event.tool, event.input);
					if (affected.length === 0) return;
					const { snapshots, escaped } = resolveAffected(location.directory, affected);
					if (escaped.length > 0) {
						return yield* Effect.fail(
							new Tool.Error({
								message: `harness: target escapes project root (${escaped.join(', ')})`
							})
						);
					}
					const files = yield* Effect.forEach(
						snapshots,
						(snap) =>
							Effect.map(readText(snap.absolutePath), (beforeContent) => ({
								filePath: snap.filePath,
								absolutePath: snap.absolutePath,
								beforeContent
							}))
					);
					pendingSnapshots.set(String(event.id), {
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

					// Terminal cleanup FIRST: failed/interrupted calls release their
					// snapshot too — full file contents are never retained (AUDIT-027).
					const snapshot = pendingSnapshots.get(callId);
					pendingSnapshots.delete(callId);

					const sessionId = String(event.sessionID);

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

					// Change-ledger recording covers EVERY affected path, including
					// patch-text paths (AUDIT-029).
					const affectedPaths = extractAffectedPaths(event.tool, event.input);
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
									readFile: (absPath: string) => readText(absPath)
								},
								request
							);
							const now = yield* Clock.currentTimeMillis;
							const reportPath = yield* persistReport(location.directory, report, now);
							console.error(
								`[opencode-effect-harness] auto-verify ${report.overall}: ${reportPath}`
							);
							yield* changes.drain({
								projectKey: location.projectKey,
								sessionID: ended.sessionID
							});
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
	now: number
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
		const target = `${dir}/${now.toString(36)}-verify.json`;
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
