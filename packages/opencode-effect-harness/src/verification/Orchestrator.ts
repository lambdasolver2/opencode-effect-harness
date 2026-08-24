/**
 * Orchestrator — the verification pipeline. Stages, in order, with Effect
 * collection combinators (never imperative loops):
 *
 *  1. resolve applicable modules from touched paths
 *  2. run each module's checkers through the shared Exec port
 *  3. parse diagnostics per module; raw status preserved
 *  4. deterministic pattern findings from each module's own catalog
 *  5. skill-evidence assessment
 *  6. optional semantic review for BOTH pass and fail when enabled;
 *     review failure is an explicit `error` state, never a silent pass
 *  7. derive `overall` by the pure report policy
 */
import { Effect, Option, Result } from 'effect';

import { Exec } from '../shared/Command.ts';
import { Input } from '../enforcement/Input.ts';
import { findPatternMatches } from '../enforcement/Matcher.ts';
import type { Pattern } from '../enforcement/Pattern.ts';
import { assessEvidence } from './Evidence.ts';
import { CheckerResult, Runner } from './Checker.ts';
import type { VerificationModule } from './Module.ts';
import { Registry } from './Module.ts';
import {
	PatternFinding,
	VerifierReport,
	VerifyRequest,
	errorSemanticReview,
	overall,
	skippedSemanticReview
} from './Report.ts';
import { Reviewer } from './Reviewer.ts';

export interface VerifyDeps {
	readonly registry: Registry.Interface;
	readonly exec: Exec.Interface;
	/** Absent reviewer => semantic review is explicitly `skipped`. */
	readonly reviewer?: Reviewer.Interface | undefined;
	/**
	 * File reader for deterministic pattern scans over touched files.
	 * Absent => pattern findings are empty for this run (recorded as such).
	 */
	readonly readFile?:
		| ((absolutePath: string) => Effect.Effect<string | undefined>)
		| undefined;
}

interface LocatedFinding {
	readonly detector: Pattern.Value;
	readonly file: string;
	readonly line: number;
	readonly snippet: string;
}

const projectionFor = (filePath: string, content: string): Input.Value =>
	new Input.Value({
		filePath: Option.some(filePath),
		content: Option.some(content),
		changedSpans: Option.none(),
		command: Option.none(),
		pattern: Option.none(),
		query: Option.none(),
		url: Option.none(),
		prompt: Option.none()
	});

export namespace Orchestrator {
	export const verify = (
		deps: VerifyDeps,
		request: VerifyRequest,
		modulesOverride?: ReadonlyArray<VerificationModule>
	): Effect.Effect<VerifierReport> =>
		Effect.gen(function*() {
			const modules =
				modulesOverride !== undefined && modulesOverride.length > 0
					? modulesOverride
					: yield* deps.registry.resolve(request.touchedFiles);

			const context = {
				projectRoot: request.projectRoot,
				touchedFiles: request.touchedFiles
			};

			const nestedChecks = yield* Effect.forEach(
				modules,
				(module) =>
					Effect.gen(function*() {
						// a module that cannot produce checkers is an ERROR result for
						// the module — it must never vanish from the report
						const attempted = yield* module.checkers(context).pipe(
							Effect.map((specs) => ({ ok: true as const, specs })),
							Effect.catchTag('ModuleError', (reason) =>
								Effect.succeed({ ok: false as const, reason })
							)
						);
						if (!attempted.ok) {
							return [
								new CheckerResult({
									specId: `${module.id}:unavailable`,
									kind: 'custom',
									label: 'module checkers unavailable',
									verdict: 'error',
									stdout: '',
									stderr: attempted.reason.reason,
									diagnostics: [],
									durationMs: 0
								})
							] as ReadonlyArray<CheckerResult>;
						}
						return yield* Effect.forEach(
							attempted.specs,
							(spec) =>
								Runner.run(deps.exec, spec, {
									parseDiagnostics: module.parseDiagnostics
								}),
							{ concurrency: 4 }
						);
					}),
				{ concurrency: 4 }
			);
			const checks: ReadonlyArray<CheckerResult> = nestedChecks.flat();

			const patternModules = modules.filter(
				(module): module is VerificationModule & {
					readonly patterns: NonNullable<VerificationModule['patterns']>;
				} => module.patterns !== undefined
			);

			const nestedFindings = yield* Effect.forEach(
				patternModules,
				(module) =>
					Effect.gen(function*() {
						const catalog = yield* module.patterns.detectors().pipe(
							Effect.map((detectors) => ({ ok: true as const, detectors })),
							Effect.catchTag('CatalogError', () =>
								Effect.succeed({ ok: false as const })
							)
						);
						if (!catalog.ok) {
							return [[]] as ReadonlyArray<ReadonlyArray<LocatedFinding>>;
						}
						return yield* Effect.forEach(
							request.touchedFiles.filter((file) => module.appliesTo(file)),
							(file) => {
								if (deps.readFile === undefined) {
									return Effect.succeed([] as ReadonlyArray<LocatedFinding>);
								}
								return Effect.flatMap(
									deps.readFile(joinPath(request.projectRoot, file)),
									(content) => {
										if (content === undefined) {
											return Effect.succeed([] as ReadonlyArray<LocatedFinding>);
										}
										const projection = projectionFor(file, content);
										return Effect.succeed(
											catalog.detectors.flatMap((detector) =>
												findPatternMatches('write', projection, 'after', detector).map(
													(location) => ({
														detector,
														file,
														line: location.line,
														snippet: location.snippet
													})
												)
											)
										);
									}
								);
							},
							{ concurrency: 8 }
						);
					}),
				{ concurrency: 4 }
			);
			const flat = nestedFindings.flat(2);
			const patternFindings = flat.map(
				(finding) =>
					new PatternFinding({
						patternName: finding.detector.name,
						level: finding.detector.level,
						file: finding.file,
						line: finding.line,
						snippet: finding.snippet,
						guidance: finding.detector.guidance.slice(0, 2_000),
						suggestedSkills: [...(finding.detector.suggestedSkills ?? [])]
					})
			);

			const codeDetected =
				checks.some((c) => c.kind === 'typecheck') ||
				request.touchedFiles.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
			const skillEvidence = assessEvidence({
				codeDetected,
				loadedSkills: request.loadedSkills,
				minRequired: request.minSkillEvidence
			});

			const semantic =
				deps.reviewer === undefined
					? skippedSemanticReview()
					: yield* deps.reviewer
						.review({
							sessionID: request.sessionID,
							checks: checks.map((c) => ({
								specId: c.specId,
								kind: c.kind,
								verdict: c.verdict,
								diagnostics: [...c.diagnostics]
							})),
							changeSet: {
								projectRoot: request.projectRoot,
								files: [],
								truncated: true
							},
							loadedSkills: request.loadedSkills
						})
						.pipe(
							// failed review infrastructure => explicit error state
							Effect.catchTag('ReviewerError', (cause) =>
								Effect.succeed(errorSemanticReview(cause.reason))
							)
						);

			return new VerifierReport({
				request,
				checks: checks.map((c) => ({
					specId: c.specId,
					kind: c.kind,
					label: c.label,
					verdict: c.verdict,
					durationMs: c.durationMs,
					diagnostics: [...c.diagnostics]
				})),
				patternFindings,
				skillEvidence,
				semantic,
				overall: overall({ checks, skillEvidence, semantic })
			});
		});

	const joinPath = (root: string, rel: string): string =>
		root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`;
}
