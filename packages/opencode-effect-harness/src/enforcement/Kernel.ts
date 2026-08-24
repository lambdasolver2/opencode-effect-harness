import { FileSystem, Layer, Path } from 'effect';

import { Catalog, CatalogError } from './Catalog.ts';
import type * as Hook from './Hook.ts';
import { Controller } from './Controller.ts';
import { Engine } from './Engine.ts';
import { HookSet } from './HookSet.ts';
import { Matcher } from './Matcher.ts';
import { Projection } from './Projection.ts';
import type * as Rule from './Rule.ts';
import { RuleSet } from './RuleSet.ts';

type Platform = FileSystem.FileSystem | Path.Path;

/**
 * Kernel — the COMPLETE host-neutral layer graph.
 *
 * The OpenCode adapter must dispatch every event through the Controller this
 * graph provides; it never constructs a second, adapter-local policy path.
 * Platform layers (FileSystem/Path) are supplied by the host composition root.
 */
export namespace Kernel {
	export interface Policy {
		readonly hooks: ReadonlyArray<Hook.Any>;
		readonly rules: ReadonlyArray<Rule.Any>;
	}

	export const layer = (
		patternsDir: string,
		policy: Policy
	): Layer.Layer<
		| Catalog.Service
		| Matcher.Service
		| Projection.Service
		| HookSet.Service
		| RuleSet.Service
		| Engine.Service
		| Controller.Service,
		CatalogError,
		Platform
	> => {
		const base = Layer.mergeAll(
			Catalog.layer(patternsDir),
			Matcher.layer,
			Projection.layer
		);
		const hooks = HookSet.of(policy.hooks);
		const rules = RuleSet.of(policy.rules);
		const engine = Engine.layer.pipe(Layer.provide(rules));
		const controller = Controller.layer.pipe(
			Layer.provide(Layer.mergeAll(hooks, engine))
		);
		return Layer.mergeAll(base, hooks, rules, engine, controller);
	};

	/** Metadata-only kernel (no hooks/rules) for pure domain consumers/tests. */
	export const domainLayer = (
		patternsDir: string
	): Layer.Layer<
		Catalog.Service | Matcher.Service | Projection.Service,
		CatalogError,
		Platform
	> =>
		Layer.mergeAll(Catalog.layer(patternsDir), Matcher.layer, Projection.layer);
}
