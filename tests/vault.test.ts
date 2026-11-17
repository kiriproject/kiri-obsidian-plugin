import type { App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { FakeApp } from './mocks/obsidian';
import { appendLogLine, FALLBACK_LOG_NOTE, getLogNote, readDailyNotesConfig } from '../src/vault/dailyNote';
import { addBlockToCounter, markTaskDone, openTasksInFile, openTasksInVault, TaskCache } from '../src/vault/tasks';
import { collectFocusEntries } from '../src/vault/stats';
import { addSpent } from '../src/logic/taskLine';
import { locateTodayItem } from '../src/logic/today';

function setup(): { fake: FakeApp; app: App } {
	const fake = new FakeApp();
	return { fake, app: fake as unknown as App };
}

function enableDailyNotes(fake: FakeApp, options: Record<string, string>): void {
	fake.internalPlugins = { getPluginById: (id: string) => (id === 'daily-notes' ? { enabled: true, instance: { options } } : null) };
}

function todayName(): string {
	const today = new Date();
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

const CREATE = { createDailyNote: true };
const NO_CREATE = { createDailyNote: false };

describe('daily note logging', () => {
	it('falls back to the Kiri focus log note when Daily notes is off', async () => {
		const { fake, app } = setup();
		expect(readDailyNotesConfig(app).enabled).toBe(false);
		const target = await getLogNote(app, NO_CREATE);
		expect(target).toMatchObject({ dated: true, reason: 'daily-notes-off' });
		expect(target.file.path).toBe(FALLBACK_LOG_NOTE);
		await appendLogLine(app, target.file, '## Focus log', '- 10:00–10:25 · Focus');
		await appendLogLine(app, target.file, '## Focus log', '- 10:30–10:55 · Focus');
		expect(fake.files.get(FALLBACK_LOG_NOTE)).toBe('## Focus log\n- 10:00–10:25 · Focus\n- 10:30–10:55 · Focus\n');
	});

	it("creates today's daily note from the template in the configured folder, when asked to", async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Day' });
		fake.files.set('Templates/Day.md', '# {{title}}\n\n## Notes\n');
		const { file, dated } = await getLogNote(app, CREATE);
		const name = todayName();
		expect(file.path).toBe(`Daily/${name}.md`);
		expect(dated).toBe(false);
		expect(fake.folders.has('Daily')).toBe(true);
		await appendLogLine(app, file, '## Focus log', '- x');
		expect(fake.files.get(file.path)).toBe(`# ${name}\n\n## Notes\n\n## Focus log\n- x\n`);
	});

	it('uses an existing daily note without touching other text', async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: '', format: 'YYYY-MM-DD', template: '' });
		const path = `${todayName()}.md`;
		fake.files.set(path, 'Morning notes\n\n## Focus log\n- a\n\n## Later\nstuff\n');
		const { file, reason } = await getLogNote(app, NO_CREATE);
		expect(file.path).toBe(path);
		expect(reason).toBeUndefined();
		await appendLogLine(app, file, '## Focus log', '- b');
		expect(fake.files.get(file.path)).toBe('Morning notes\n\n## Focus log\n- a\n- b\n\n## Later\nstuff\n');
	});

	it("by default never creates today's daily note: the line goes to the fallback note (review 2, note safety S1)", async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: 'Daily', format: 'YYYY-MM-DD', template: '' });
		const target = await getLogNote(app, NO_CREATE);
		expect(target).toMatchObject({ dated: true, reason: 'daily-note-missing' });
		expect(target.file.path).toBe(FALLBACK_LOG_NOTE);
		expect(fake.files.has(`Daily/${todayName()}.md`)).toBe(false);
	});

	it('never creates an empty daily note when the template cannot be found', async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Gone' });
		const target = await getLogNote(app, CREATE);
		expect(target).toMatchObject({ dated: true, reason: 'template-missing', template: 'Templates/Gone.md' });
		expect(target.file.path).toBe(FALLBACK_LOG_NOTE);
		expect(fake.files.has(`Daily/${todayName()}.md`)).toBe(false);
	});

	it('uses a daily note that arrived (synced) just before the create', async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: '', format: 'YYYY-MM-DD', template: 'T' });
		fake.files.set('T.md', '# {{title}}\n');
		const path = `${todayName()}.md`;
		// The template read is the last await before create: the synced note lands then.
		const read = fake.vault.cachedRead;
		fake.vault.cachedRead = async (f) => {
			const text = await read(f);
			fake.files.set(path, 'From my phone\n');
			return text;
		};
		const { file } = await getLogNote(app, CREATE);
		expect(file.path).toBe(path);
		expect(fake.files.get(path)).toBe('From my phone\n');
	});
});

describe('task picking and editing', () => {
	const NOTE = 'Projects/Plan.md';
	const content = '# Plan\n- [ ] Write intro\n- [x] Done\n- [ ] Draft outline 📅 2026-11-20\n```\n- not a task\n```\n';

	it('lists open tasks of a note with their text as is', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const tasks = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		expect(tasks.map((t) => [t.line, t.text])).toEqual([
			[1, 'Write intro'],
			[3, 'Draft outline 📅 2026-11-20'],
		]);
		expect(tasks[0]?.noteName).toBe('Plan');
	});

	it('searches the vault and caps results', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		fake.files.set('Other.md', '- [ ] Write outro\n- [ ] Call\n');
		const all = await openTasksInVault(app, 'write');
		expect(all?.tasks.map((t) => t.text).sort()).toEqual(['Write intro', 'Write outro']);
		const capped = await openTasksInVault(app, '', { limit: 2 });
		expect(capped?.tasks).toHaveLength(2);
		expect(capped?.capped).toBe(true);
	});

	it('reads each note once across queries with a cache, and again only after it changed (review 2, code S1)', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		fake.files.set('Other.md', '- [ ] Write outro\n- [ ] Call\n');
		let reads = 0;
		const read = fake.vault.cachedRead;
		fake.vault.cachedRead = async (f) => {
			reads++;
			return read(f);
		};
		const cache = new TaskCache();
		await openTasksInVault(app, 'w', { cache });
		expect(reads).toBe(2);
		const second = await openTasksInVault(app, 'call', { cache });
		expect(second?.tasks.map((t) => t.text)).toEqual(['Call']);
		expect(reads).toBe(2);
		fake.files.set('Other.md', '- [ ] Call Ann\n');
		cache.invalidate('Other.md');
		const third = await openTasksInVault(app, 'call', { cache });
		expect(third?.tasks.map((t) => t.text)).toEqual(['Call Ann']);
		expect(reads).toBe(3);
	});

	it('stops a scan as soon as a newer one starts', async () => {
		const { fake, app } = setup();
		for (let i = 0; i < 50; i++) fake.files.set(`N${i}.md`, '- [ ] t\n');
		let reads = 0;
		const read = fake.vault.cachedRead;
		fake.vault.cachedRead = async (f) => {
			reads++;
			return read(f);
		};
		const result = await openTasksInVault(app, 'nothing matches', { isStale: () => reads >= 3 });
		expect(result).toBeNull();
		expect(reads).toBe(3);
	});

	it('increments the counter twice, keeping Tasks fields', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const [, task] = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		const once = await addBlockToCounter(app, task!);
		expect(once?.raw).toBe('- [ ] Draft outline [kiri:: 1] 📅 2026-11-20');
		const twice = await addBlockToCounter(app, once!);
		expect(twice?.raw).toBe('- [ ] Draft outline [kiri:: 2] 📅 2026-11-20');
		expect(fake.files.get(NOTE)).toBe(content.replace('Draft outline 📅', 'Draft outline [kiri:: 2] 📅'));
	});

	it('finds the task again after lines were added above it', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const [task] = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		fake.files.set(NOTE, 'New first line\n' + content);
		const done = await markTaskDone(app, task!);
		expect(done?.line).toBe(2);
		expect(fake.files.get(NOTE)).toBe('New first line\n' + content.replace('- [ ] Write intro', '- [x] Write intro'));
	});

	it('changes nothing when the task line is gone', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const [task] = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		fake.files.set(NOTE, '# Plan\n- [ ] Write intro (edited)\n');
		expect(await markTaskDone(app, task!)).toBeNull();
		expect(fake.files.get(NOTE)).toBe('# Plan\n- [ ] Write intro (edited)\n');
	});

	it('uses the Tasks plugin API when it is on', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const calls: string[] = [];
		fake.plugins = {
			enabledPlugins: new Set(['obsidian-tasks-plugin']),
			plugins: {
				'obsidian-tasks-plugin': {
					apiV1: {
						executeToggleTaskDoneCommand: (line: string, path: string) => {
							calls.push(`${path}|${line}`);
							return line.replace('[ ]', '[x]') + ' ✅ 2026-11-14';
						},
					},
				},
			},
		};
		const [task] = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		await markTaskDone(app, task!);
		expect(calls).toEqual([`${NOTE}|- [ ] Write intro`]);
		expect(fake.files.get(NOTE)).toContain('- [x] Write intro ✅ 2026-11-14\n');
	});
});

describe('focus stats from the vault', () => {
	it('reads dated daily notes in the folder and dated fallback lines', async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: 'Daily', format: 'YYYY-MM-DD', template: '' });
		fake.files.set('Daily/2026-11-14.md', '## Focus log\n- 09:00–09:25 · Focus · [[Plan]] · Write\n');
		fake.files.set('Daily/2026-11-15.md', '## Focus log\n- 09:00–09:50 · Focus\n');
		fake.files.set('Daily/notes about days.md', '- 09:00–09:25 · Focus\n');
		fake.files.set('Other/2026-11-13.md', '- 09:00–09:25 · Focus\n');
		fake.files.set(FALLBACK_LOG_NOTE, '## Focus log\n- 2026-11-10 08:00–08:25 · Focus\n- 08:00–08:25 · Focus\n');
		const entries = await collectFocusEntries(app);
		expect(entries).toEqual([
			{ date: '2026-11-14', minutes: 25, note: 'Plan' },
			{ date: '2026-11-15', minutes: 50, note: null },
			{ date: '2026-11-10', minutes: 25, note: null },
		]);
	});

	it('supports nested date formats', async () => {
		const { fake, app } = setup();
		enableDailyNotes(fake, { folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD', template: '' });
		fake.files.set('Journal/2026/11/2026-11-15.md', '- 09:00–09:25 · Focus\n');
		expect(await collectFocusEntries(app)).toEqual([{ date: '2026-11-15', minutes: 25, note: null }]);
	});
});

describe('ticking a Today task in its note', () => {
	const NOTE = 'Projects/Plan.md';
	const content = '# Plan\n- [ ] Write intro 📅 2026-11-20\n- [ ] Draft outline\n';

	async function firstTask(app: App) {
		const [task] = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		return task!;
	}

	it('adds the time so far and ticks the task in one edit, keeping Tasks dates last', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const task = await firstTask(app);
		fake.files.set(NOTE, 'Moved down\n' + content);
		const done = await markTaskDone(app, task, (line) => addSpent(line, 12));
		expect(done?.line).toBe(2);
		expect(fake.files.get(NOTE)).toBe('Moved down\n# Plan\n- [x] Write intro [spent:: 12m] 📅 2026-11-20\n- [ ] Draft outline\n');
	});

	function withTasksPlugin(fake: FakeApp, toggle: (line: string) => string): string[] {
		const seen: string[] = [];
		fake.plugins = {
			enabledPlugins: new Set(['obsidian-tasks-plugin']),
			plugins: {
				'obsidian-tasks-plugin': {
					apiV1: {
						executeToggleTaskDoneCommand: (line: string) => {
							seen.push(line);
							return toggle(line);
						},
					},
				},
			},
		};
		return seen;
	}

	it('ticks through the Tasks plugin first, then adds the time to the completed line', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const seen = withTasksPlugin(fake, (line) => line.replace('[ ]', '[x]') + ' ✅ 2026-11-16');
		await markTaskDone(app, await firstTask(app), (line) => addSpent(line, 5));
		expect(seen).toEqual(['- [ ] Write intro 📅 2026-11-20']);
		expect(fake.files.get(NOTE)).toContain('- [x] Write intro [spent:: 5m] 📅 2026-11-20 ✅ 2026-11-16\n');
	});

	it('puts the time on the completed occurrence of a recurring task, not on the new one (review S4)', async () => {
		const { fake, app } = setup();
		const recurring = '# Plan\n- [ ] Water plants [kiri:: 2] [spent:: 50m] [planned:: 1h] 🔁 every day 📅 2026-11-16\n- [ ] Other\n';
		fake.files.set(NOTE, recurring);
		// What the Tasks plugin returns for a recurring task: the next occurrence, built
		// from the same description, above the completed one (its default order).
		const seen = withTasksPlugin(fake, (line) => {
			const next = line.replace('📅 2026-11-16', '📅 2026-11-17');
			const done = line.replace('[ ]', '[x]') + ' ✅ 2026-11-16';
			return `${next}\n${done}`;
		});
		const done = await markTaskDone(app, await firstTask(app), (line) => addSpent(line, 10));
		expect(done).not.toBeNull();
		expect(seen).toEqual(['- [ ] Water plants [kiri:: 2] [spent:: 50m] [planned:: 1h] 🔁 every day 📅 2026-11-16']);
		expect(fake.files.get(NOTE)).toBe(
			'# Plan\n' +
				'- [ ] Water plants [planned:: 1h] 🔁 every day 📅 2026-11-17\n' +
				'- [x] Water plants [kiri:: 2] [spent:: 1h] [planned:: 1h] 🔁 every day 📅 2026-11-16 ✅ 2026-11-16\n' +
				'- [ ] Other\n',
		);
	});

	it('handles a Tasks result with the new occurrence below and CRLF line endings', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, '- [ ] Run [spent:: 5m] 🔁 every week 📅 2026-11-16\r\n');
		withTasksPlugin(fake, (line) => `${line.replace('[ ]', '[x]')} ✅ 2026-11-16\r\n${line.replace('11-16', '11-23')}`);
		const [task] = await openTasksInFile(app, app.vault.getFileByPath(NOTE)!);
		await markTaskDone(app, task!, (line) => addSpent(line, 20));
		expect(fake.files.get(NOTE)).toBe(
			'- [x] Run [spent:: 25m] 🔁 every week 📅 2026-11-16 ✅ 2026-11-16\r\n- [ ] Run 🔁 every week 📅 2026-11-23\r\n',
		);
	});

	it('ticks without changes when the pre-edit gives nothing', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		await markTaskDone(app, await firstTask(app), () => null);
		expect(fake.files.get(NOTE)).toBe(content.replace('- [ ] Write intro', '- [x] Write intro'));
	});

	it('changes nothing when the line is gone or already done', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const task = await firstTask(app);
		const edited = content.replace('Write intro', 'Write the intro');
		fake.files.set(NOTE, edited);
		expect(await markTaskDone(app, task, (line) => addSpent(line, 5))).toBeNull();
		expect(fake.files.get(NOTE)).toBe(edited);
	});

	it('finds a Today item again after the note changed, and sees it ticked there', async () => {
		const { fake, app } = setup();
		fake.files.set(NOTE, content);
		const task = await firstTask(app);
		const lines = (s: string) => s.split('\n');
		expect(locateTodayItem(task, lines('Above\n' + content))).toMatchObject({ kind: 'same', line: 2 });
		await markTaskDone(app, task);
		expect(locateTodayItem(task, lines(fake.files.get(NOTE)!))).toMatchObject({ kind: 'done', line: 1, raw: '- [x] Write intro 📅 2026-11-20' });
	});
});
