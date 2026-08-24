import { defineConfig } from 'vitest/config';

export default defineConfig({
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
