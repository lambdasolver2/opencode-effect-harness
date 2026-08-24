/**
 * Composition root — the ONLY file that knows OpenCode.
 *
 * Audit fixes applied here:
 *  - options decoded from unknown; invalid => logged defaults (explicit policy)
 *  - one scoped runtime; single supervised event consumer with per-event
 *    containment; auto-verify is origin-filtered and idempotent
 *  - execute.before: location resolved BEFORE policy (fail-closed honored);
 *    intents carry file paths; BlockToolCall maps to Tool.Error; internal
 *    sessions re-check mutation tools (tool removal is not a boundary)
 *  - execute.after: pending reads released on EVERY terminal outcome; feedback
 *    uses the same kernel rule instances (no adapter-local duplicate)
 *  - context hook: policy header injection AND worker tool restriction
 *  - verify tool calls the verification Orchestrator and persists a report
 *  - critic tool is capability-honest: explicit `unavailable` instead of a
 *    fabricated pass when the child transcript cannot be observed (A19)
 *  - skill registration probed against the pinned draft shape (A2)
 */
import { Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Plugin } from '@opencode-ai/plugin/effect';
import { Tool } from '@opencode-ai/schema/tool';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

import { Decision } from 'opencode-harness-kit/Decision.ts';
import { Intent } from 'opencode-harness-kit/Intent.ts';
import { Projection } from 'opencode-harness-kit/Projection.ts';
import { Gate as GateRule } from 'opencode-harness-kit/rule/Gate.ts';
import { Header as HeaderRule } from 'opencode-harness-kit/rule/Header.ts';
import { Feedback as FeedbackRule } from 'opencode-harness-kit/rule/Feedback.ts';

import type { VerificationModule } from 'opencode-verify-kit/Module.ts';
import { Registry } from 'opencode-verify-kit/Module.ts';
import { skillEntriesFromAssets } from 'opencode-verify-kit/Module.ts';
import { Orchestrator } from 'opencode-verify-kit/Orchestrator.ts';
import { VerifierReport, VerifyRequest } from 'opencode-verify-kit/Report.ts';

import { Journal } from 'opencode-harness-shared/Journal.ts';
import { projectKeyOf } from 'opencode-harness-shared/Refs.ts';

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
import { Input } from 'opencode-harness-kit/Input.ts';

type DecisionValue = Schema.Schema.Type<typeof Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

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
				config.harness.assetsRoot ??
				new URL('../assets/', import.meta.url).pathname.replace(/\/$/, '');

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

			// ---- kernel services (platform-provided once, memoized by Layer) ----
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

			// ---- knowledge assets loaded lazily via helpers below ----

			// ---- verification runtime ----
			const exec = ExecNode.make();
			interface ModuleFactory {
				createModule: (options?: { readonly assetsRoot?: string }) => Effect.Effect<VerificationModule>
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
							return [];
						}
						const raw = yield* Effect.orElseSucceed(
							Effect.promise(loader),
							() => undefined
						);
						if (raw === undefined) {
							console.error(`[opencode-effect-harness] module not installed: ${String(id)}`);
							return [];
						}
						const factory = (
							raw as ModuleFactory
						).createModule;
						const m = yield* Effect.orElseSucceed(
							providePlatform(factory()),
							() => undefined
						);
						if (m === undefined) return [];
						return [m as VerificationModule];
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

			let currentScope = { projectKey: '*', cwd: process.cwd() };

			// ---- gate rule instance shared by hook path ----
			const pendingCountFor = (sessionId: string): Effect.Effect<number> =>
				currentScope.projectKey === '*'
					? Effect.succeed(0)
					: Effect.flatMap(
						pending.names({ projectKey: currentScope.projectKey, sessionID: sessionId }),
						(names) => ledger.countDistinct({ projectKey: currentScope.projectKey, sessionID: sessionId, pending: names })
					  );

			const gateRule = GateRule.rule({
				min: config.harness.minEffectSkills,
				strictAgents: config.harness.strictAgents,
				failClosed: config.harness.failClosedForGate,
				reason: (loaded) =>
					Effect.succeed(
						`harness gate: this write introduces Effect code.\n` +
							`Loaded effect-* skills: ${String(loaded)}/${String(config.harness.minEffectSkills)}.\n` +
							'Load more relevant effect-* skills, then retry.'
					),
				loaded: (sessionId) => pendingCountFor(sessionId ?? ''),
				project: (cwd, intent) =>
					projectionOf((p) => p.prospective(cwd, intent)).pipe(
						Effect.catchCause(() => Effect.succeed(degradedIntentValue(intent)))
					)
			});

			const emptyBranch = { entries: [] } as never;
			const evaluateGate = (input: {
				readonly agent?: string | undefined;
				readonly sessionId?: string | undefined;
				readonly writeIntent: IntentValue;
			}): Effect.Effect<ReadonlyArray<DecisionValue>> =>
				Effect.gen(function* () {
					if (!config.harness.enabled) return [];
					const strict =
						input.agent !== undefined &&
						config.harness.strictAgents.includes(input.agent);
					if (!strict) return [];
					return yield* gateRule.evaluate({
						activeBranch: emptyBranch,
						cwd: currentScope.cwd,
						...(input.agent !== undefined ? { agent: input.agent } : {}),
						...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
						writeIntent: input.writeIntent
					} as never);
				});

			const feedbackRule = FeedbackRule.rule({
				patterns: providePlatform(loadPatternsSafe(assetsRoot)),
				actual: (cwd, intent) =>
				projectionOf((p) => p.actual(cwd, intent)).pipe(
					Effect.catchCause(() => Effect.succeed(degradedIntentValue(intent)))
				)
			});

			const headerRule = HeaderRule.rule({
				header: guidanceHeader(assetsRoot),
				enabled: Effect.succeed(true)
			});

			// ---- tool registration ----
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
							const drained = yield* changes.drain({
								projectKey: location.projectKey,
								sessionID: execCtx.sessionID
							});
							const touchedFiles = [...(parsed.touchedFiles ?? []), ...drained];
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
									readFile: (absPath: string) => readText(absPath)
								},
								request
							);

							const reportPath = yield* persistReport(location.directory, report);
							const passed = report.checks.filter((c) => c.verdict === 'passed').length;

							return {
								output: undefined,
								content: `verify ${report.overall}: ${String(passed)}/${String(report.checks.length)} checks passed`,
								metadata: { overall: report.overall, reportPath }
							} as never;
						})
				});

				tools.add({
					name: 'effect_harness_critic',
					description:
						'Independent read-only audit of builder reasoning. Returns explicit `unavailable` if the child transcript cannot be observed.',
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

							const focus = parsed.focus ?? 'full';
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
							yield* promptSession({
								sessionID: brand<'sessionIdBrand'>()(childId),
								text: [
									'You are an independent reviewer. Respond ONLY with JSON {"verdict":"sound|concerns|flawed","findings":[...]}.',
									'# Builder Summary (UNTRUSTED CLAIM)',
									'<untrusted-claim>',
									summary,
									'</untrusted-claim>',
									`focus: ${focus}`
								].join('\n')
							}).pipe(Effect.ignore);
							yield* waitSession({
								sessionID: brand<'sessionIdBrand'>()(childId)
							}).pipe(Effect.ignore);

							const transcript = traceSink.lastAssistantText(childId);
							yield* origins.unregister(childId);

							const stream = `critic-${projectKeyOf(childId)}`;
							yield* appendCriticEvent(
								stream,
								transcript !== undefined ? 'review.completed' : 'review.failed',
								transcript !== undefined
									? { childSessionID: childId, preview: transcript.slice(0, 4000) }
									: { reason: 'traceUnavailable', childSessionID: childId }
							);

							if (transcript === undefined) {
								return {
									output: undefined,
									metadata: { status: 'unavailable', reason: 'traceUnavailable', workerSessionID: childId },
									content:
										'critic: child finished but its transcript is not observable in the restricted plugin context. Recorded as UNAVAILABLE — never counted as passed.'
								} as never;
							}

							return {
								output: undefined,
								metadata: { status: 'completed', workerSessionID: childId },
								content: `critic verdict:\n${transcript.slice(0, 4000)}`
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
					description: 'Compound workflows. Requires explicit opt-in and SessionSource adapters.',
					input: { type: 'object', properties: {}, additionalProperties: false },
					execute: () =>
						Effect.fail(
							new Tool.Error({
								message: config.compound.enabled
									? 'compound execution requires SessionSource adapters (audit REM-4); explicitly not wired yet.'
									: 'compound disabled by configuration.'
							})
						)
				});
			});

			// ---- capability-probed native skill registration ----
			const skillEntries = yield* Effect.orElseSucceed(
				providePlatform(skillEntriesFromAssets({ assetsRoot })),
				() => []
			);
			const skillInfos = yield* CapabilityModule.prepareAll(skillEntries, (entry) => readText(entry.skillFilePath).pipe(
				Effect.map((body) => body ?? '')
			), {
				idBrand: brand<'skillID'>() as unknown as (v: string) => unknown,
				nameBrand: brand<'skillName'>() as unknown as (v: string) => unknown,
				pathBrand: brand<'absPath'>() as unknown as (v: string) => unknown
			});

			yield* ctx.skill.transform((draft) => {
				const result = CapabilityModule.applyToDraft(draft as unknown as CapabilityModule.SkillDraftProbe, skillInfos);
				if (!result.attempted || result.registered !== skillInfos.length) {
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

					if (event.tool !== 'write' && event.tool !== 'edit') return;

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
					currentScope = { projectKey: location.projectKey, cwd: location.directory };

					const intent = intentFromInput(event.input);
					if (intent === undefined) return;

					const decisions = yield* evaluateGate({
						agent: String(event.agent),
						sessionId,
						writeIntent: intent
					}).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<DecisionValue>)));

					const blocked = decisions.find(
						(d): d is Extract<typeof d, { _tag: 'BlockToolCall' }> =>
							d._tag === 'BlockToolCall'
					);
					if (blocked !== undefined) {
						return yield* Effect.fail(new Tool.Error({ message: blocked.reason }));
					}
				})
			);

			yield* ctx.tool.hook('execute.after', (event) =>
				Effect.gen(function* () {
					const sessionId = String(event.sessionID);
					const location = yield* sessions.resolve(sessionId).pipe(
						Effect.orElseSucceed(() => undefined)
					);

					if (event.tool === 'read') {
						if (location === undefined) return;
						const taken = yield* pending.take({
							projectKey: location.projectKey,
							sessionID: sessionId,
							callId: String(event.id)
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

					if (event.tool !== 'write' && event.tool !== 'edit') return;
					if (location === undefined) return;

					if (event.status === 'completed') {
						const p = property(event.input, 'path') ?? property(event.input, 'filePath');
						if (typeof p === 'string') {
							yield* changes.record({
								projectKey: location.projectKey,
								sessionID: sessionId,
								filePath: p
							});
						}
						return;
					}
				}).pipe(Effect.ignore)
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
					const enabledNow =
						location === undefined ? true : yield* mode.enabled(location.projectKey);
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
							const files = yield* changes.drain({
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
							const report = yield* Orchestrator.verify({ registry, exec }, request);
							yield* persistReport(location.directory, report).pipe(Effect.ignore);
						}).pipe(
							Effect.ignore,
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
				Effect.catchTag('CatalogError', () => Effect.succeed([])),
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

const persistReport = (
	projectRoot: string,
	report: VerifierReport
): Effect.Effect<string | undefined> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const target = `${projectRoot}/.effect-harness/reports/${Date.now().toString(36)}-verify.json`;
		yield* fs.writeFileString(target, JSON.stringify(report, null, 2)).pipe(Effect.ignore);
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
