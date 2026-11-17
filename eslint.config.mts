import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'vitest.config.ts',
		'test-vault',
		'scripts',
		// The test stand-in for the obsidian module needs the real moment package.
		'tests/mocks',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// "Kiri" is the product name, "Dataview" a plugin name and "Today" the name of
			// the panel's list of tasks. Strings naming the Tasks plugin or showing the
			// literal [kiri:: 2] field are checked by hand.
			'obsidianmd/ui/sentence-case': [
				'warn',
				{ brands: ['Kiri', 'Dataview', 'Today'], ignoreRegex: ['Tasks plugin', '\\[kiri::'] },
			],
		},
	},
);
