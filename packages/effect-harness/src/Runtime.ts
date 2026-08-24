/**
 * Runtime — composes the kernel with effect-specific services and rules.
 * Mode gating lives inside the RuleSet; hooks stay installed while disabled
 * so skill reads keep being credited (upstream invariant).
 */
import { Context, Effect, Layer } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';

import { Kernel } from 'opencode-harness-kit/kernel/Kernel.ts';

import { Catalog } from './services/Catalog.ts';
import { Guidance } from './services/Guidance.ts';
import { Ledger } from './services/Ledger.ts';
import { Pending } from './services/Pending.ts';

export declare namespace Runtime {
	export interface Options {
		/** Absolute package root — skills/, patterns/, guidance/ live here. */
		readonly root: string;
	}
}

export namespace Runtime {
	export const layer = (options: Runtime.Options) => {
		// 1. Platform — FileSystem + Path, needed by any service that touches disk
		const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

		// 2. Kernel — PatternCatalog (reads *.md detectors), Matcher (ast-grep), Projection.
		//    Needs platform because it reads pattern files from disk.
		const kernel = Layer.provide(
			Kernel.layer(`${options.root}/patterns`),
			platform
		);

		// 3. Guidance — reads guidance/*.md files for policy header. Needs platform.
		const guidance = Layer.provide(
			Guidance.layer(`${options.root}/guidance`),
			platform
		);

		// 4. Skills catalog — discovers effect-* skill directories. Needs platform.
		const skills = Layer.provide(
			Catalog.layer(`${options.root}/skills`),
			platform
		);

		// 5. In-memory services — no platform needed.
		//    Pending tracks in-flight reads; Ledger tracks loaded skills per session.

		return Layer.mergeAll(kernel, guidance, skills, Pending.layer, Ledger.layer);
	};

	export namespace strict {
		export const isStrict = (
			agent: string,
			strictAgents: ReadonlyArray<string>
		): boolean => strictAgents.includes(agent);
	}
}
