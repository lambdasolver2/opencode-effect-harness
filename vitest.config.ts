import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'opencode-harness-kit': new URL('./packages/harness-kit/src/', import.meta.url).pathname,
			'opencode-harness-shared': new URL('./packages/shared/src/', import.meta.url).pathname,
			'opencode-verify-kit': new URL('./packages/verify-kit/src/', import.meta.url).pathname,
			'opencode-compound-kit': new URL('./packages/compound-kit/src/', import.meta.url).pathname,
			'opencode-bench-store': new URL('./packages/bench-store/src/', import.meta.url).pathname,
			'@opencode-effect-harness/module-typescript': new URL('./packages/module-typescript/src/', import.meta.url).pathname,
			'@opencode-effect-harness/module-bend': new URL('./packages/module-bend/src/', import.meta.url).pathname
		}
	},
	test: {
		setupFiles: ['./vitest.setup.ts'],
		include: [
			'src/**/*.test.ts',
			'packages/*/src/**/*.test.ts'
		],
		passWithNoTests: false,
		globals: false,
		testTimeout: 30000,
		hookTimeout: 30000,
		pool: 'forks',
		isolate: false
	}
});
