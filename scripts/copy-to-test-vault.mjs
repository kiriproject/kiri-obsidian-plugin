// Copy the built plugin into the test vault. Run with `npm run dev-vault`.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const target = join('test-vault', '.obsidian', 'plugins', 'kiri-focus-timer');
mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	if (!existsSync(file)) {
		console.error(`Missing ${file}. Run npm run build first.`);
		process.exit(1);
	}
	copyFileSync(file, join(target, file));
}
console.log(`Copied main.js, manifest.json and styles.css to ${target}`);
