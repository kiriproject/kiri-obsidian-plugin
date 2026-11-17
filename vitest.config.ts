import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// The obsidian package has types only; tests use a small in-memory fake.
			obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url)),
		},
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
	},
});
