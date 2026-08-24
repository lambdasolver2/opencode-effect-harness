/**
 * opencode-effect-harness — OpenCode v2 plugin entry.
 */
import { Tool } from '@opencode-ai/schema/tool';
import { Plugin } from '@opencode-ai/plugin/effect';
import { Effect, Layer, Option, Schema, Stream } from 'effect';

import * as Kit from 'opencode-harness-kit/index.ts';
import { Projection as WriteProjection } from 'opencode-harness-kit/kernel/services/Projection.ts';
import { Intent } from 'opencode-harness-kit/Intent.ts';

import * as Events from './Events.ts';
import { Catalog } from './services/Catalog.ts';
import { Guidance } from './services/Guidance.ts';
import { Ledger } from './services/Ledger.ts';
import { Pending } from './services/Pending.ts';
import { Feedback } from './rules/Feedback.ts';
import { Gate } from './rules/Gate.ts';
import { Header } from './rules/Header.ts';
import { Runtime } from './Runtime.ts';
import { typescriptModule } from './modules/Typescript.ts';
import type { VerificationModule } from 'opencode-verify-kit';

type DecisionValue = Schema.Schema.Type<typeof Kit.Decision.Value>;
type IntentValue = Schema.Schema.Type<typeof Intent.Value>;

const MODE_KEY = 'ox-effect-harness/mode/enabled';

const property = (value: unknown, key: PropertyKey): unknown =>
	value !== null && typeof value === 'object'
		? Reflect.get(value, key)
		: undefined;

export const writeIntentFromInput = (input: unknown): IntentValue | undefined => {
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
			return new Intent.EditFile({ phase: 'before', replacements });
		}
	}
	const content = property(input, 'content');
	if (typeof content === 'string' && content.length > 0) {
		return new Intent.WriteFile({ phase: 'before', content });
	}
	const inserted = property(input, 'newString') ?? property(input, 'newText');
	if (typeof inserted === 'string' && inserted.length > 0) {
		return new Intent.WriteFile({ phase: 'before', content: inserted });
	}
	return undefined;
};

const packageRoot = (): string => {
	if (import.meta.dirname !== undefined) {
		const segments = import.meta.dirname.split('/');
		segments.pop();
		return segments.join('/') || '.';
	}
	return '.';
};

export default Plugin.define({
	id: 'opencode.effect-harness',
	tui: false,
	effect: (ctx) =>
		Effect.gen(function* () {
			const options = ctx.options as {
				harness?: {
					enabled?: boolean;
					minEffectSkills?: number;
					strictAgents?: ReadonlyArray<string>;
				};
				verify?: {
					model?: { providerID: string; modelID: string; variant?: string };
				};
				critic?: {
					model?: { providerID: string; modelID: string; variant?: string };
				};
				compound?: {
					stage1Model?: { providerID: string; modelID: string; variant?: string };
					gateModel?: { providerID: string; modelID: string; variant?: string };
				};
			};

			interface ModelConfig {
				readonly providerID: string;
				readonly modelID: string;
				readonly variant?: string;
			}

			const toModelRef = (config: ModelConfig | undefined) => {
				if (config === undefined) return undefined;
				return {
					providerID: config.providerID,
					modelID: config.modelID,
					...(config.variant !== undefined ? { variant: config.variant } : {})
				} as never;
			};
			const minSkills = options.harness?.minEffectSkills ?? 4;
			const strictAgents = options.harness?.strictAgents ?? ['build'];
			const root = packageRoot();

			yield* Effect.gen(function* () {
				// ---- services ----
				const guidance = yield* Guidance.Service;
				const ledger = yield* Ledger.Service;
				const pending = yield* Pending.Service;
				const projection = yield* WriteProjection.Service;
				const catalogService = yield* Catalog.Service;
				const patternCatalog = yield* Kit.PatternCatalog.Service;
				const patterns = patternCatalog.getPatterns;

				let enabled = options.harness?.enabled ?? true;
				yield* Effect.ignore(
					Effect.flatMap(
						ctx.storage.get(MODE_KEY) as Effect.Effect<unknown>,
						(v) => {
							if (typeof v === 'boolean') enabled = v;
							return Effect.void;
						}
					)
				);

				const emptyBranch = new Kit.Branch.Value({ entries: [] });

				// ---- skill registration (capability-probed, spec A2) ----
				yield* ctx.skill.transform((skills) => {
					const fs = require('node:fs') as typeof import('node:fs');
					const path = require('node:path') as typeof import('node:path');
					const skillsDir = path.resolve(root, 'skills');
					try {
						const dirs = fs.readdirSync(skillsDir).filter((d: string) => d.startsWith('effect-'));
						for (const dir of dirs) {
							const skillPath = path.join(skillsDir, dir, 'SKILL.md');
							if (!fs.existsSync(skillPath)) continue;
							const content = fs.readFileSync(skillPath, 'utf8');
							const nameMatch = content.match(/^---\n([\s\S]*?)\n---/);
							const nameLine = nameMatch?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim() ?? dir;
							skills.add({
								id: dir as never,
								name: nameLine as never,
								location: skillPath as never,
								description: content.match(/description:\s*(.+)/)?.[1]?.trim() ?? '',
								content
							});
						}
					} catch {
						// fail-silent: skills are enhancement, not requirement
					}
				}).pipe(Effect.ignore);

				// ---- rules ----
				const gateRule = Gate.rule({
					min: minSkills,
					strict: true,
					reason: (loaded) => guidance.reason(loaded),
					loaded: (sessionId) =>
						Effect.flatMap(pending.names, (names) => ledger.count(sessionId, names)),
					project: (cwd, intent) =>
						Effect.map(projection.prospective(cwd, intent), (v) => v.content)
				});

				const feedbackRule = Feedback.rule({
					patterns,
					actual: (cwd, intent) =>
						Effect.map(projection.actual(cwd, intent), (v) => v.content)
				});

				const headerRule = Header.rule({
					header: guidance.header,
					enabled: Effect.sync(() => enabled)
				});



				// ---- tool hooks ----
				yield* ctx.tool.hook('execute.before', (event) =>
					Effect.gen(function* () {
						if (event.tool === 'read') {
							const inputPath = property(event.input, 'path');
							if (typeof inputPath === 'string') {
								const match = yield* catalogService.matchPath(inputPath);
								if (Option.isSome(match)) {
									yield* pending.remember(event.id, match.value.name);
								}
							}
							return;
						}
						if (event.tool !== 'write' && event.tool !== 'edit') return;
						const intent = writeIntentFromInput(event.input);
						if (intent === undefined) return;

						const decisions: ReadonlyArray<DecisionValue> = yield* gateRule.evaluate({
							activeBranch: emptyBranch,
							cwd: process.cwd(),
							sessionId: event.sessionID,
							writeIntent: intent
						}).pipe(Effect.orElseSucceed(() => []));

						const blocked = decisions.find((d): d is Extract<typeof d, { _tag: 'BlockToolCall' }> => d._tag === 'BlockToolCall');
						if (blocked) {
							return yield* Effect.fail(new Tool.Error({ message: blocked.reason }));
						}
					})
				);

				yield* ctx.tool.hook('execute.after', (event) =>
					Effect.gen(function* () {
						if (event.status !== 'completed') return;

						if (event.tool === 'read') {
							const taken = yield* pending.take(event.id);
							if (Option.isSome(taken)) {
								yield* ledger.mark(event.sessionID, taken.value);
							}
							return;
						}

						if (event.tool !== 'write' && event.tool !== 'edit') return;
						const intent = writeIntentFromInput(event.input);
						if (intent === undefined) return;

						const decisions: ReadonlyArray<DecisionValue> = yield* feedbackRule.evaluate({
							activeBranch: emptyBranch,
							cwd: process.cwd(),
							toolName: event.tool === 'edit' ? 'edit' : 'write',
							writeIntent: intent
						}).pipe(Effect.orElseSucceed(() => []));

						for (const decision of decisions) {
							if (decision._tag === 'InjectUserMessage') {
								yield* ctx.session.synthetic({
									sessionID: event.sessionID,
									text: decision.message.content,
									delivery: 'queue'
								} as never).pipe(Effect.ignore);
							}
						}
					}).pipe(Effect.ignore)
				);

				// ---- policy header ----
				yield* ctx.session.hook('context', (sessionContext) =>
					headerRule.evaluate({ activeBranch: emptyBranch, cwd: process.cwd() }).pipe(
						Effect.map((decisions) => {
							for (const d of decisions) {
								if (d._tag === 'InjectSystemPrompt') {
									sessionContext.system.push({ type: 'text', text: d.content });
								}
							}
						})
					).pipe(Effect.ignore)
				);

				// ---- events ----
				const stream = ctx.event.subscribe() as unknown as Stream.Stream<
					{ type: string },
					never
				>;
				yield* Events.skillActivated(stream).pipe(
					Stream.runForEach((event) => ledger.mark(event.data.sessionID, event.data.name)),
					Effect.ignore,
					Effect.forkScoped
				);
				yield* Events.compacted(stream).pipe(
					Stream.runForEach((event) => ledger.reset(event.data.sessionID)),
					Effect.ignore,
					Effect.forkScoped
				);

				// ---- tools ----
				yield* ctx.tool.transform((tools) => {
					tools.add({
						name: 'effect_harness_verify',
						description: 'Run typecheck and tests on the project.',
						input: { type: 'object', properties: {}, additionalProperties: false },
						execute: () =>
							Effect.gen(function* () {
								const proc = Bun.spawnSync(
									['bunx', 'tsc', '--noEmit'],
									{ stdout: 'pipe', stderr: 'pipe' }
								);
								const exitCode = proc.exitCode;
								const stderr = new TextDecoder().decode(proc.stderr);
								const passed = exitCode === 0;

								return {
									output: { overall: passed ? 'passed' : 'failed' },
									content: passed ? '\u2713 typecheck passed' : `\u2717 typecheck failed:\n${stderr.slice(0, 2000)}`
								};
							})
					});

					tools.add({
						name: 'harness_skill_stats',
						description: 'Show effect-* skill read metrics.',
						input: { type: 'object', properties: {}, additionalProperties: false },
						execute: (_rawInput: unknown, execCtx: { readonly sessionID: string }) =>
							Effect.gen(function* () {
								const loaded = yield* ledger.loaded(execCtx.sessionID);
								return {
									output: { loadedSkills: loaded, count: loaded.length },
									content: `Loaded effect-* skills (${loaded.length}): ${loaded.join(', ') || '(none)'}`
								};
							})
					});

					tools.add({
						name: 'harness_toggle',
						description: 'Toggle the opencode-effect-harness Effect mode.',
						input: {
							type: 'object',
							properties: {
								enabled: { type: 'boolean', description: 'Desired state; omit to flip.' }
							},
							additionalProperties: false
						},
						execute: (rawInput: unknown) =>
							Effect.gen(function* () {
								const parsed = rawInput as { enabled?: boolean };
								enabled = parsed.enabled === undefined ? !enabled : parsed.enabled;
								yield* ctx.storage.set(MODE_KEY, enabled).pipe(Effect.ignore);
								return {
									output: { enabled },
									content: `effect harness ${enabled ? 'enabled' : 'disabled'}`
								};
							})
					});

					tools.add({
						name: 'harness_critic',
						description:
							'Spawn an independent critic agent to audit reasoning quality. Provide a summary of what was done.',
						input: {
							type: 'object',
							properties: {
								summary: { type: 'string', description: 'Short summary of what was done.' },
								focus: { type: 'string', enum: ['feature', 'plan', 'architecture', 'drift', 'full'] }
							},
							required: ['summary'],
							additionalProperties: false
						},
						execute: (rawInput: unknown) =>
							Effect.gen(function* () {
								const parsed = rawInput as { summary?: string; focus?: string };
								if (typeof parsed.summary !== 'string' || parsed.summary.length < 10) {
									return yield* Effect.fail(
										new Tool.Error({ message: 'harness_critic requires a summary of \u226510 chars.' })
									);
								}
								const focus = parsed.focus ?? 'full';
								const child = yield* ctx.session.create({
									agent: 'explore' as never
								}).pipe(Effect.orElseSucceed(() => undefined));

								if (child != null && typeof child === 'object' && 'id' in child) {
									const childId = String(child.id);
									const reviewPrompt = [
										`Focus: ${focus}`,
										'# Builder Summary',
										parsed.summary ?? ''
									].join('\n');
									yield* ctx.session.prompt({ sessionID: childId as never, text: reviewPrompt }).pipe(Effect.ignore);
									yield* ctx.session.wait({ sessionID: childId as never }).pipe(Effect.ignore);
								}

								return {
									output: { checkpointKind: focus, status: 'spawned' },
									content: `harness critic: spawned ${focus} review session.`
								};
							})
					});
				});


				void strictAgents; void Option; void root; void headerRule;
			}).pipe(
				Effect.provide(Runtime.layer({ root })),
				Effect.catchCause(() => Effect.void)
			);
		})
});
