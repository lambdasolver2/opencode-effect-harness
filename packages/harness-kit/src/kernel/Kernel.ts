import { Layer } from 'effect';

import { Catalog } from './services/Catalog.ts';
import { Matcher } from './services/Matcher.ts';
import { Projection } from './services/Projection.ts';
import { Rules } from './services/Rules.ts';

export namespace Kernel {
	export const layer = (patternsDir: string) => {
		const baseLayer = Layer.mergeAll(
			Catalog.layer(patternsDir),
			Matcher.layer,
			Projection.layer
		);
		return Layer.mergeAll(
			baseLayer,
			Rules.layer.pipe(Layer.provide(baseLayer))
		);
	};
}
