/**
 * Module domain — the per-language extension point. A module owns its checkers
 * AND its knowledge base (skills + patterns), so verification is never bound
 * to one language's catalog (spec A32). Serializable module configuration is
 * separate from executable module values.
 */
import { Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';

import type { CommandResult } from 'opencode-harness-shared';
import type { CatalogError } from 'opencode-harness-kit/Catalog.ts';
import { Pattern } from 'opencode-harness-kit/Pattern.ts';
import { loadPatterns } from 'opencode-harness-kit/Catalog.ts';
import type { CheckerSpec, Diagnostic } from './Checker.ts';

export interface ProjectContext {
	readonly projectRoot: string;
	readonly touchedFiles: ReadonlyArray<string>;
}

/** Per-module skill knowledge base backed by the SAME asset tree as enforcement. */
export interface ModuleSkillCatalog {
	readonly root: string;
	readonly entries: ReadonlyArray<{
		readonly name: string;
		readonly skillFilePath: string;
	}>;
	load(name: string): Effect.Effect<string, ModuleError>;
}

export interface ModulePatternCatalog {
	readonly root: string;
	detectors(): Effect.Effect<ReadonlyArray<Pattern.Value>, CatalogError>;
}

export class ModuleError extends Schema.TaggedError<ModuleError>()(
	'ModuleError',
	{
		moduleId: Schema.String,
		reason: Schema.String
	}
) {}

export interface VerificationModule {
	readonly id: string;
	readonly languages: ReadonlyArray<string>;
	readonly appliesTo: (filePath: string) => boolean;
	checkers(
		context: ProjectContext
	): Effect.Effect<ReadonlyArray<CheckerSpec>, ModuleError>;
	parseDiagnostics?(
		spec: CheckerSpec,
		result: CommandResult
	): ReadonlyArray<Diagnostic>;
	readonly skills?: ModuleSkillCatalog | undefined;
	readonly patterns?: ModulePatternCatalog | undefined;
}

/**
 * Build a module pattern catalog from the shared immutable asset tree. The
 * verifier reads exactly the detectors enforcement reads — one catalog, two
 * consumers, no hand-maintained copies.
 */
export const patternCatalogFromAssets = (
	patternsDir: string
): Effect.Effect<
	ModulePatternCatalog,
	CatalogError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.map(loadPatterns(patternsDir), (detectors) => ({
		root: patternsDir,
		detectors: () => Effect.succeed(detectors)
	}));

/** Discover bundled skill entries under the skills asset directory. */
export const skillEntriesFromAssets = (input: {
	readonly assetsRoot: string;
}): Effect.Effect<
	ReadonlyArray<{ name: string; skillFilePath: string }>,
	CatalogError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function*() {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const skillsDir = path.join(input.assetsRoot, 'skills');
		const names = yield* fs.readDirectory(skillsDir).pipe(
			Effect.catchTag('PlatformError', () =>
				Effect.succeed([] as ReadonlyArray<string>)
			)
		);
		return yield* Effect.forEach(
			names.filter((n) => n.startsWith('effect-')),
			(name) => {
				const filePath = path.join(skillsDir, name, 'SKILL.md');
				return fsExists(fs, filePath).pipe(
					Effect.map((exists) => (exists ? [{ name, skillFilePath: filePath }] : []))
				);
			},
			{ concurrency: 8 }
		).pipe(Effect.map((groups) => groups.flat()));
	});

const fsExists = (fs: FileSystem.FileSystem, target: string) =>
	fs.exists(target).pipe(
		Effect.catchTag('PlatformError', () => Effect.succeed(false))
	);

export namespace Registry {
	export interface Interface {
		register(module: VerificationModule): Effect.Effect<void>;
		all(): Effect.Effect<ReadonlyArray<VerificationModule>>;
		resolve(
			touchedFiles: ReadonlyArray<string>
		): Effect.Effect<ReadonlyArray<VerificationModule>>;
	}

	export class Service extends Context.Service<Service, Interface>()(
		'opencode-effect-harness/verification/Registry'
	) {}

	export const make = (modules: ReadonlyArray<VerificationModule>): Interface => {
		const registered = [...modules];
		return {
			register: (module) => Effect.sync(() => void registered.push(module)),
			all: () => Effect.succeed([...registered]),
			resolve: (touchedFiles) =>
				Effect.succeed(
					registered.filter((m) => touchedFiles.some((f) => m.appliesTo(f)))
				)
		};
	};

	export const layerOf = (modules: ReadonlyArray<VerificationModule>) =>
		Layer.succeed(Service, Service.of(make(modules)));
}
