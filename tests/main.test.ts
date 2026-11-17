// Orchestration tests for src/main.ts: the plugin runs against the in-memory vault
// in tests/mocks/obsidian.ts, with the clock faked so blocks and midnight can pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApp, fakeVersion, notices, openedPickers } from './mocks/obsidian';
import KiriPlugin, { MAX_AUTO_BLOCKS, NOT_FOUND_ON_TODAY, NOT_FOUND_TO_UPDATE, SWITCH_NOT_FOUND, SYNC_GRACE_MS } from '../src/main';
import type { TaskItem } from '../src/vault/tasks';
import type { TodayState } from '../src/logic/today';

interface Internals {
	tick(): void;
	stored: (Record<string, unknown> & { today?: TodayState }) | null;
	unload(): void;
}

const NOTE = 'Projects/Plan.md';
const LOG = 'Kiri focus log.md';

function at(h: number, m: number, day = 16): Date {
	return new Date(2026, 10, day, h, m, 0, 0);
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function setup(files: Record<string, string>, settings: Record<string, unknown> = {}, today?: TodayState): Promise<{ fake: FakeApp; plugin: KiriPlugin; internals: Internals }> {
	const fake = new FakeApp();
	for (const [p, data] of Object.entries(files)) fake.files.set(p, data);
	const plugin = new KiriPlugin(fake as never, { id: 'kiri-focus-timer', version: '0.3.0', dir: '.obsidian/plugins/kiri-focus-timer' } as never);
	const internals = plugin as unknown as Internals;
	internals.stored = { chime: false, writeSpent: true, ...settings, ...(today ? { today } : {}) };
	await plugin.onload();
	fake.readyLayout();
	await flush();
	return { fake, plugin, internals };
}

function task(path: string, line: number, raw: string): TaskItem {
	return { path, line, raw, text: raw.replace(/^\s*- \[.\] /, ''), noteName: path.split('/').pop()!.replace(/\.md$/, '') };
}

/** Pass `minutes` of a running block, ticking like the real 500 ms interval does at its end. */
function pass(internals: Internals, to: Date): void {
	vi.setSystemTime(to);
	internals.tick();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(at(9, 0));
	vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => undefined, setTimeout: (fn: () => void) => setTimeout(fn, 0), open: () => null });
	notices.length = 0;
});

afterEach(() => {
	fakeVersion.current = '1.10.0';
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('Today tasks ticked or edited in the note (review S1)', () => {
	const content = '# Plan\n- [x] Email Bob ✅ 2026-11-09\n- [ ] Email Bob\n- [ ] Other\n';

	it('an edited open task stays on Today and no time goes to the older completed copy', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: content });
		plugin.addToToday(task(NOTE, 2, '- [ ] Email Bob'));
		plugin.startFocus();
		pass(internals, at(9, 10));
		// The user dates the open task while the block runs.
		fake.files.set(NOTE, content.replace('- [ ] Email Bob\n', '- [ ] Email Bob 📅 2026-11-20\n'));
		fake.emitChanged(NOTE);
		await flush();
		expect(plugin.today.items.map((i) => i.raw)).toEqual(['- [ ] Email Bob 📅 2026-11-20']);
		expect(fake.files.get(NOTE)).toContain('- [x] Email Bob ✅ 2026-11-09\n');
		expect(fake.files.get(NOTE)).not.toContain('spent');
	});

	it('an open task edited beyond its words is kept and marked stale, never ticked', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: content });
		plugin.addToToday(task(NOTE, 2, '- [ ] Email Bob'));
		await flush();
		fake.files.set(NOTE, content.replace('- [ ] Email Bob\n', '- [ ] Email Bob about the invoice\n'));
		fake.emitChanged(NOTE);
		expect(plugin.today.items).toHaveLength(1);
		expect(plugin.today.items[0]?.stale).toBe(true);
		expect(internals.stored?.today?.items[0]?.stale).toBe(true);
		// Words back as they were: no longer stale.
		fake.files.set(NOTE, content);
		fake.emitChanged(NOTE);
		expect(plugin.today.items[0]?.stale).toBeUndefined();
	});

	it('a tick of the tracked line itself leaves Today and gets the time so far', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: content });
		plugin.addToToday(task(NOTE, 2, '- [ ] Email Bob'));
		await flush();
		plugin.startFocus();
		// Lines added above while the block runs: the item's line is kept up to date.
		const moved = 'New line\nAnother\n' + content;
		fake.files.set(NOTE, moved);
		fake.emitChanged(NOTE);
		expect(plugin.today.items[0]?.line).toBe(4);
		pass(internals, at(9, 12));
		fake.files.set(NOTE, moved.replace('- [ ] Email Bob\n', '- [x] Email Bob\n'));
		fake.emitChanged(NOTE);
		await flush();
		expect(plugin.today.items).toEqual([]);
		expect(fake.files.get(NOTE)).toBe('New line\nAnother\n# Plan\n- [x] Email Bob ✅ 2026-11-09\n- [x] Email Bob [spent:: 12m]\n- [ ] Other\n');
	});

	it('a deleted line that lets the old completed copy move into its place is not a tick', async () => {
		const below = '- [ ] Email Bob\n- [x] Email Bob\n- [ ] Other\n';
		const { fake, plugin, internals } = await setup({ [NOTE]: below });
		plugin.addToToday(task(NOTE, 0, '- [ ] Email Bob'));
		await flush();
		plugin.startFocus();
		pass(internals, at(9, 5));
		fake.files.set(NOTE, '- [x] Email Bob\n- [ ] Other\n');
		fake.emitChanged(NOTE);
		await flush();
		expect(plugin.today.items[0]?.stale).toBe(true);
		// A later edit elsewhere does not turn it into a tick either.
		fake.files.set(NOTE, '- [x] Email Bob\n- [ ] Other edited\n');
		fake.emitChanged(NOTE);
		await flush();
		expect(plugin.today.items).toHaveLength(1);
		expect(fake.files.get(NOTE)).not.toContain('spent');
	});
});

describe('midnight during a block (review S2)', () => {
	it('keeps Today until the block ends, names the task, then starts the new day', async () => {
		vi.setSystemTime(at(23, 40));
		const { fake, plugin, internals } = await setup({ [NOTE]: '- [ ] Late task\n' }, { taskCounter: true });
		plugin.addToToday(task(NOTE, 0, '- [ ] Late task'));
		await flush();
		vi.setSystemTime(at(23, 50));
		plugin.startFocus();
		pass(internals, at(0, 1, 17));
		expect(plugin.today.items).toHaveLength(1);
		pass(internals, at(0, 15, 17));
		await flush();
		expect(fake.files.get(LOG)).toContain('Late task');
		expect(fake.files.get(NOTE)).toBe('- [ ] Late task [kiri:: 1] [spent:: 25m]\n');
		// The first tick after the block: the new day starts.
		pass(internals, at(0, 16, 17));
		expect(plugin.today).toEqual({ day: '2026-11-17', items: [] });
	});

	it('starts the new day at midnight when no block runs, and never on a date going back', async () => {
		vi.setSystemTime(at(23, 59));
		const { plugin, internals } = await setup({ [NOTE]: '- [ ] A\n' });
		plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		pass(internals, at(23, 58, 15));
		expect(plugin.today.items).toHaveLength(1);
		pass(internals, at(0, 0, 17));
		expect(plugin.today.items).toEqual([]);
	});
});

describe('renamed and deleted notes (review S3)', () => {
	it('follows a renamed note, saves the new path, and ticks the task there', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: '- [ ] A\n- [ ] B\n' });
		plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		plugin.addToToday(task('Other.md', 0, '- [ ] C'));
		fake.renameFile(NOTE, 'Archive/Plan 2026.md');
		expect(plugin.today.items.map((i) => [i.path, i.noteName])).toEqual([
			['Archive/Plan 2026.md', 'Plan 2026'],
			['Other.md', 'Other'],
		]);
		expect(internals.stored?.today?.items[0]?.path).toBe('Archive/Plan 2026.md');
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(true);
		expect(fake.files.get('Archive/Plan 2026.md')).toBe('- [x] A\n- [ ] B\n');
	});

	it('follows a renamed folder and the single picked task', async () => {
		const { fake, plugin } = await setup({ [NOTE]: '- [ ] A\n' });
		plugin.selectTask(task(NOTE, 0, '- [ ] A'));
		fake.renameFile('Projects', 'Work', true);
		expect(plugin.picked?.path).toBe('Work/Plan.md');
	});

	it('marks the tasks of a deleted note stale, and they recover if the note comes back', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: '- [ ] A\n' });
		plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		fake.deleteFile(NOTE);
		expect(plugin.today.items[0]?.stale).toBe(true);
		expect(internals.stored?.today?.items[0]?.stale).toBe(true);
		fake.files.set(NOTE, '- [ ] A\n');
		fake.emitChanged(NOTE);
		expect(plugin.today.items[0]?.stale).toBeUndefined();
	});

	it('stops listening when the plugin is turned off', async () => {
		const { fake, internals } = await setup({});
		expect(fake.vaultEvents.count('rename')).toBe(1);
		expect(fake.vaultEvents.count('delete')).toBe(1);
		expect(fake.metadataEvents.count('changed')).toBe(1);
		internals.unload();
		expect(fake.vaultEvents.count('rename')).toBe(0);
		expect(fake.vaultEvents.count('delete')).toBe(0);
		expect(fake.metadataEvents.count('changed')).toBe(0);
	});
});

describe('Today at start and from outside', () => {
	it('checks saved tasks against their notes when Obsidian starts', async () => {
		const saved: TodayState = {
			day: '2026-11-16',
			items: [task(NOTE, 0, '- [ ] A'), task('Gone.md', 0, '- [ ] G'), task(NOTE, 1, '- [ ] B')],
		};
		const { plugin } = await setup({ [NOTE]: 'Added while closed\n- [ ] A 📅 2026-11-20\n- [ ] B\n' }, {}, saved);
		expect(plugin.today.items.map((i) => [i.raw, i.line, i.stale ?? false])).toEqual([
			['- [ ] A 📅 2026-11-20', 1, false],
			['- [ ] G', 0, true],
			['- [ ] B', 2, false],
		]);
	});

	it('takes the Today list from data.json when it changed outside (review N8)', async () => {
		const { plugin, internals } = await setup({ [NOTE]: '- [ ] A\n- [ ] B\n' });
		plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		internals.stored = { ...internals.stored, today: { day: '2026-11-16', items: [task(NOTE, 1, '- [ ] B'), task(NOTE, 0, '- [ ] A')] } };
		await plugin.onExternalSettingsChange();
		expect(plugin.today.items.map((i) => i.raw)).toEqual(['- [ ] B', '- [ ] A']);
	});
});

describe('ticking in the panel during a block', () => {
	it('gives the time so far to a recurring task ticked through Tasks, not its next occurrence', async () => {
		const raw = '- [ ] Water [spent:: 10m] 🔁 every day 📅 2026-11-16';
		const { fake, plugin, internals } = await setup({ [NOTE]: `${raw}\n- [ ] Next\n` });
		fake.plugins = {
			enabledPlugins: new Set(['obsidian-tasks-plugin']),
			plugins: {
				'obsidian-tasks-plugin': {
					apiV1: {
						executeToggleTaskDoneCommand: (line: string) =>
							`${line.replace('11-16', '11-17')}\n${line.replace('[ ]', '[x]')} ✅ 2026-11-16`,
					},
				},
			},
		};
		plugin.addToToday(task(NOTE, 0, raw));
		plugin.addToToday(task(NOTE, 1, '- [ ] Next'));
		plugin.startFocus();
		pass(internals, at(9, 15));
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(true);
		expect(fake.files.get(NOTE)).toBe(
			'- [ ] Water 🔁 every day 📅 2026-11-17\n- [x] Water [spent:: 25m] 🔁 every day 📅 2026-11-16 ✅ 2026-11-16\n- [ ] Next\n',
		);
		expect(plugin.task?.raw).toBe('- [ ] Next');
		// Obsidian then reports the note changed: the next task is still found.
		fake.emitChanged(NOTE);
		expect(plugin.today.items.map((i) => [i.raw, i.line])).toEqual([['- [ ] Next', 2]]);
	});
});

describe('switching the current task during a block', () => {
	const three = '- [ ] A\n- [ ] B\n- [ ] C\n';
	async function withToday(settings: Record<string, unknown> = {}): Promise<{ fake: FakeApp; plugin: KiriPlugin; internals: Internals }> {
		const r = await setup({ [NOTE]: three }, settings);
		r.plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		r.plugin.addToToday(task(NOTE, 1, '- [ ] B'));
		r.plugin.addToToday(task(NOTE, 2, '- [ ] C'));
		await flush();
		return r;
	}
	const raws = (plugin: KiriPlugin): string[] => plugin.today.items.map((i) => i.raw);

	it('a click on another task gives the time so far to the old one, not done, and the rest to the new one', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 10));
		expect(plugin.selectTask(plugin.today.items[1]!)).toBe(true);
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 10m]\n- [ ] B\n- [ ] C\n');
		expect(raws(plugin)).toEqual(['- [ ] B', '- [ ] A [spent:: 10m]', '- [ ] C']);
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 10m]\n- [ ] B [spent:: 15m]\n- [ ] C\n');
		// The log line names the task current at the end.
		expect(fake.files.get(LOG)).toBe('## Focus log\n- 2026-11-16 09:00–09:25 · Focus · [[Plan]] · B\n');
	});

	it('"Next task" moves the current task to the end, still open, and splits the block', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 5));
		expect(plugin.nextTask()).toBe(true);
		await flush();
		expect(raws(plugin)).toEqual(['- [ ] B', '- [ ] C', '- [ ] A [spent:: 5m]']);
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 5m]\n- [ ] B [spent:: 20m]\n- [ ] C\n');
	});

	it('"Next task" with one task does nothing and says so', async () => {
		const { plugin } = await setup({ [NOTE]: three });
		plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		expect(plugin.nextTask()).toBe(false);
		expect(notices).toContain('No other task on Today.');
		expect(raws(plugin)).toEqual(['- [ ] A']);
	});

	it('a move down (buttons or drag) and a removal of the current task split the block too', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 4));
		plugin.moveTodayItem(0, 1);
		await flush();
		pass(internals, at(9, 10));
		// B is current now; taking it off Today gives it its 6 minutes without ticking it.
		plugin.removeTodayItem(0);
		await flush();
		expect(raws(plugin)).toEqual(['- [ ] A [spent:: 4m]', '- [ ] C']);
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 19m]\n- [ ] B [spent:: 6m]\n- [ ] C\n');
	});

	it('a quick switch back and forth writes nothing for the few seconds', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 10));
		plugin.selectTask(plugin.today.items[1]!);
		await flush();
		vi.setSystemTime(new Date(at(9, 10).getTime() + 10_000));
		plugin.selectTask(plugin.today.items[1]!);
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 10m]\n- [ ] B\n- [ ] C\n');
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 25m]\n- [ ] B\n- [ ] C\n');
	});

	it('ticking the current task after a switch still gives each task its own part', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 5));
		plugin.nextTask();
		await flush();
		pass(internals, at(9, 12));
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(true);
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 5m]\n- [x] B [spent:: 7m]\n- [ ] C [spent:: 13m]\n');
		expect(fake.files.get(LOG)).toBe('## Focus log\n- 2026-11-16 09:00–09:25 · Focus · [[Plan]] · C\n');
	});

	it('with "Add time spent" off nothing is written on a switch, and the block is still split', async () => {
		const { fake, plugin, internals } = await withToday({ writeSpent: false });
		plugin.startFocus();
		pass(internals, at(9, 10));
		plugin.nextTask();
		await flush();
		expect(fake.files.get(NOTE)).toBe(three);
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe(three);
	});

	it('a line that cannot be found: one notice, the block goes on and keeps its split', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 5));
		// A and B were changed in the note without Obsidian telling Kiri yet.
		fake.files.set(NOTE, '- [ ] A edited\n- [ ] B edited\n- [ ] C\n');
		plugin.nextTask();
		await flush();
		pass(internals, at(9, 10));
		plugin.nextTask();
		await flush();
		expect(notices.filter((n) => n === SWITCH_NOT_FOUND)).toHaveLength(1);
		expect(plugin.timer.phase).toBe('focus');
		pass(internals, at(9, 25));
		await flush();
		// C gets only what is left after A's 5 and B's 5 minutes.
		expect(fake.files.get(NOTE)).toBe('- [ ] A edited\n- [ ] B edited\n- [ ] C [spent:: 15m]\n');
	});

	it('outside a focus block, switching writes nothing', async () => {
		const { fake, plugin } = await withToday();
		plugin.nextTask();
		plugin.selectTask(plugin.today.items[2]!);
		await flush();
		expect(fake.files.get(NOTE)).toBe(three);
	});

	it('"Switch task…" picks from Today; with Today empty, from the open note; otherwise says so', async () => {
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 8));
		await plugin.openSwitchTask();
		const picker = openedPickers.at(-1) as unknown as { getItems(): { raw: string }[]; onChooseItem(t: unknown): void };
		expect(picker.getItems().map((t) => t.raw)).toEqual(['- [ ] A', '- [ ] B', '- [ ] C']);
		picker.onChooseItem(picker.getItems()[2]);
		await flush();
		expect(plugin.task?.raw).toBe('- [ ] C');
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 8m]\n- [ ] B\n- [ ] C\n');

		plugin.stop();
		for (let i = 0; i < 3; i++) plugin.removeTodayItem(0);
		fake.activeFile = NOTE;
		const before = openedPickers.length;
		await plugin.openSwitchTask();
		expect(openedPickers.length).toBe(before + 1);
		fake.activeFile = null;
		await plugin.openSwitchTask();
		expect(openedPickers.length).toBe(before + 1);
		expect(notices.some((n) => n.startsWith('Today is empty'))).toBe(true);
	});

	it('a switched block survives a restart and the rest goes to the new task', async () => {
		fakeVersion.current = '1.12.0';
		const { fake, plugin, internals } = await withToday();
		plugin.startFocus();
		pass(internals, at(9, 10));
		plugin.nextTask();
		await flush();
		const data = internals.stored;
		internals.unload();

		vi.setSystemTime(at(9, 12));
		const second = new KiriPlugin(fake as never, { id: 'kiri-focus-timer', version: '0.3.2', dir: '.obsidian/plugins/kiri-focus-timer' } as never);
		const secondInternals = second as unknown as Internals;
		secondInternals.stored = data;
		await second.onload();
		fake.readyLayout();
		await flush();
		expect(second.timer.phase).toBe('focus');
		expect(second.task?.raw).toBe('- [ ] B');
		pass(secondInternals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe('- [ ] A [spent:: 10m]\n- [ ] B [spent:: 15m]\n- [ ] C\n');
		fakeVersion.current = '1.10.0';
	});
});

describe('identical task lines (review 2, note safety S2)', () => {
	const twice = ['# Work', '- [ ] Review', ...Array.from({ length: 9 }, (_, i) => `note ${i}`), '# Home', '- [ ] Review', ''].join('\n');

	it('the picked task is followed as lines are added above it, and the right copy is edited', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: twice }, { taskCounter: true, writeSpent: false });
		plugin.selectTask({ ...task(NOTE, 12, '- [ ] Review'), copy: 1, copies: 2 });
		plugin.startFocus();
		// A long writing session above both copies, one save at a time.
		let text = twice;
		for (let i = 0; i < 40; i++) {
			text = `typed ${i}\n${text}`;
			fake.files.set(NOTE, text);
			fake.emitChanged(NOTE);
		}
		expect(plugin.picked?.line).toBe(52);
		pass(internals, at(9, 25));
		await flush();
		const lines = fake.files.get(NOTE)!.split('\n');
		expect(lines[41]).toBe('- [ ] Review');
		expect(lines[52]).toBe('- [ ] Review [kiri:: 1]');
	});

	it('finds the right copy even after one big jump (a paste) between saves', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: twice }, { taskCounter: true, writeSpent: false });
		plugin.selectTask({ ...task(NOTE, 12, '- [ ] Review'), copy: 1, copies: 2 });
		plugin.startFocus();
		// 11 lines pasted above: the other copy moves onto the remembered line 12.
		fake.files.set(NOTE, `${'pasted\n'.repeat(11)}${twice}`);
		pass(internals, at(9, 25));
		await flush();
		const lines = fake.files.get(NOTE)!.split('\n');
		expect(lines[12]).toBe('- [ ] Review');
		expect(lines[23]).toBe('- [ ] Review [kiri:: 1]');
	});

	it('refuses with a notice when it can no longer tell the copies apart', async () => {
		const { fake, plugin, internals } = await setup({ [NOTE]: twice }, { taskCounter: true, writeSpent: false });
		plugin.selectTask({ ...task(NOTE, 12, '- [ ] Review'), copy: 1, copies: 2 });
		plugin.startFocus();
		const third = `${twice}- [ ] Review\n`;
		fake.files.set(NOTE, third);
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(NOTE)).toBe(third);
		expect(notices).toContain(NOT_FOUND_TO_UPDATE);
	});

	it('a Today task that is one of two copies ticks its own copy', async () => {
		const { fake, plugin } = await setup({ [NOTE]: twice });
		plugin.addToToday({ ...task(NOTE, 12, '- [ ] Review'), copy: 1, copies: 2 });
		fake.files.set(NOTE, `${'pasted\n'.repeat(11)}${twice}`);
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(true);
		const lines = fake.files.get(NOTE)!.split('\n');
		expect(lines[12]).toBe('- [ ] Review');
		expect(lines[23]).toBe('- [x] Review');
	});

	it('a Today task saved without its copy is never ticked while the note holds it twice', async () => {
		const { fake, plugin } = await setup({ [NOTE]: twice });
		plugin.addToToday(task(NOTE, 12, '- [ ] Review'));
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(false);
		expect(fake.files.get(NOTE)).toBe(twice);
		expect(notices).toContain(NOT_FOUND_ON_TODAY);
	});

	it('tasks listed from a note carry which copy they are', async () => {
		const { fake } = await setup({ [NOTE]: twice });
		const { openTasksInFile } = await import('../src/vault/tasks');
		const tasks = await openTasksInFile(fake as never, fake.vault.getFileByPath(NOTE) as never);
		expect(tasks.map((t) => [t.line, t.copy, t.copies])).toEqual([
			[1, 0, 2],
			[12, 1, 2],
		]);
	});
});

describe('Kanban boards', () => {
	const BOARD = 'Boards/Work.md';
	const board = '---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] Card one\n- [ ] Card two\n';

	it('lists no tasks from a board, in the note or across the vault', async () => {
		const { fake } = await setup({ [BOARD]: board, [NOTE]: '- [ ] Real task\n' });
		const { openTasksInFile, openTasksInVault } = await import('../src/vault/tasks');
		expect(await openTasksInFile(fake as never, fake.vault.getFileByPath(BOARD) as never)).toEqual([]);
		const all = await openTasksInVault(fake as never, '');
		expect(all?.tasks.map((t) => t.raw)).toEqual(['- [ ] Real task']);
	});

	it('never edits a board, even for a card picked before it became one', async () => {
		const { fake, plugin, internals } = await setup({ [BOARD]: board }, { taskCounter: true, askMarkDone: false });
		plugin.addToToday(task(BOARD, 6, '- [ ] Card one'));
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(false);
		plugin.startFocus();
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(BOARD)).toBe(board);
	});

	it('"Add open tasks from this note" says the board is left alone', async () => {
		const { fake, plugin } = await setup({ [BOARD]: board });
		await plugin.addNoteTasksToToday(fake.vault.getFileByPath(BOARD) as never);
		expect(plugin.today.items).toEqual([]);
		expect(notices.some((n) => n.includes('Kanban board'))).toBe(true);
	});
});

describe("today's daily note (review 2, note safety S1)", () => {
	function dailyOn(fake: FakeApp, template = ''): void {
		fake.internalPlugins = {
			getPluginById: (id: string) => (id === 'daily-notes' ? { enabled: true, instance: { options: { folder: 'Daily', format: 'YYYY-MM-DD', template } } } : null),
		};
	}
	const DAY = 'Daily/2026-11-16.md';

	it('by default logs to the fallback note with a notice once a day, and creates no daily note', async () => {
		const { fake, plugin, internals } = await setup({});
		dailyOn(fake);
		plugin.startFocus();
		pass(internals, at(9, 25));
		await flush();
		pass(internals, at(9, 30));
		plugin.startFocus();
		pass(internals, at(9, 55));
		await flush();
		expect(fake.files.has(DAY)).toBe(false);
		expect(fake.files.get(LOG)).toBe('## Focus log\n- 2026-11-16 09:00–09:25 · Focus\n- 2026-11-16 09:30–09:55 · Focus\n');
		expect(notices.filter((n) => n.startsWith("Today's daily note does not exist yet"))).toHaveLength(1);
	});

	it('logs to the daily note once it exists', async () => {
		const { fake, plugin, internals } = await setup({ [DAY]: '# Monday\n' });
		dailyOn(fake);
		plugin.startFocus();
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(DAY)).toBe('# Monday\n\n## Focus log\n- 09:00–09:25 · Focus\n');
		expect(fake.files.has(LOG)).toBe(false);
	});

	it('with "Create today\'s daily note" on, creates it from the template; a missing template creates nothing', async () => {
		const { fake, plugin, internals } = await setup({ 'T.md': '# {{title}}\n' }, { createDailyNote: true });
		dailyOn(fake, 'T');
		plugin.startFocus();
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(DAY)).toBe('# 2026-11-16\n\n## Focus log\n- 09:00–09:25 · Focus\n');

		fake.files.delete(DAY);
		dailyOn(fake, 'Templates/Gone');
		pass(internals, at(9, 30));
		plugin.startFocus();
		pass(internals, at(9, 55));
		await flush();
		expect(fake.files.has(DAY)).toBe(false);
		expect(fake.files.get(LOG)).toContain('- 2026-11-16 09:30–09:55 · Focus');
		expect(notices.some((n) => n.includes('could not find your daily note template (Templates/Gone.md)'))).toBe(true);
	});

	it('a block noticed late (after sleep) waits for sync before looking for the note', async () => {
		const delays: number[] = [];
		let release: (() => void) | null = null;
		vi.stubGlobal('window', {
			setInterval: () => 0,
			clearInterval: () => undefined,
			setTimeout: (fn: () => void, ms: number) => {
				delays.push(ms);
				if (ms === SYNC_GRACE_MS) release = fn;
				else setTimeout(fn, 0);
				return 0;
			},
			open: () => null,
		});
		const { fake, plugin, internals } = await setup({}, { createDailyNote: true });
		dailyOn(fake);
		plugin.startFocus();
		// The lid was closed from 9:10 to 11:00.
		pass(internals, at(11, 0));
		await flush();
		expect(delays).toContain(SYNC_GRACE_MS);
		expect(fake.files.has(DAY)).toBe(false);
		// Sync brings the note written on the phone, then the wait ends.
		fake.files.set(DAY, 'From my phone\n');
		(release as (() => void) | null)?.();
		await flush();
		expect(fake.files.get(DAY)).toBe('From my phone\n\n## Focus log\n- 09:00–09:25 · Focus\n');
	});

	it('the log line keeps the task words, not its tags, fields or links (review 2, note safety N1)', async () => {
		const raw = '- [ ] Write #work report [project:: Alpha] [[Client|ACME]] for (owner:: me) 📅 2026-11-20 ^abc';
		const { fake, plugin, internals } = await setup({ [NOTE]: `${raw}\n` });
		plugin.selectTask(task(NOTE, 0, raw));
		plugin.startFocus();
		pass(internals, at(9, 25));
		await flush();
		expect(fake.files.get(LOG)).toBe('## Focus log\n- 2026-11-16 09:00–09:25 · Focus · [[Plan]] · Write report ACME for\n');
	});
});

describe('"Start the next block after the break" with nobody there (review 2, note safety S4)', () => {
	function runFor(internals: Internals, hours: number): void {
		const start = Date.now();
		for (let t = 1; t <= hours * 60; t++) pass(internals, new Date(start + t * 60_000));
	}
	const blocks = (fake: FakeApp): number => (fake.files.get(LOG) ?? '').split('\n').filter((l) => l.includes('· Focus')).length;

	it('stops after the long break of the cycle', async () => {
		const { fake, plugin, internals } = await setup({}, { autoStartNext: true });
		plugin.startFocus();
		runFor(internals, 6);
		await flush();
		expect(blocks(fake)).toBe(4);
		expect(plugin.timer.phase).toBe('idle');
		expect(plugin.hint).toContain('waits for you');
	});

	it(`stops after ${MAX_AUTO_BLOCKS} blocks in a row without long breaks, and a click starts the count again`, async () => {
		const { fake, plugin, internals } = await setup({}, { autoStartNext: true, longBreakEnabled: false });
		plugin.startFocus();
		runFor(internals, 6);
		await flush();
		expect(blocks(fake)).toBe(1 + MAX_AUTO_BLOCKS);
		plugin.startFocus();
		runFor(internals, 6);
		await flush();
		expect(blocks(fake)).toBe(2 * (1 + MAX_AUTO_BLOCKS));
	});

	it('does not start a block after a break that ended while the device slept', async () => {
		const { plugin, internals } = await setup({}, { autoStartNext: true });
		plugin.startFocus();
		pass(internals, at(9, 25));
		// The break ended at 9:30; the lid opens at 11:00.
		pass(internals, at(11, 0));
		expect(plugin.timer.phase).toBe('idle');
	});
});

describe('a Kiri sound that finishes downloading after the plugin was turned off (review 2, code S2)', () => {
	it('does not start playing', async () => {
		const { plugin, internals } = await setup({});
		const priv = plugin as unknown as {
			account: { info: unknown };
			soundCache: { ensure: (key: string) => Promise<unknown> };
			sound: { playRecording: (...args: unknown[]) => Promise<void> };
		};
		priv.account.info = { token: 'tok-12345678', connectionId: 'conn-12345678', name: '', emailHint: '', plan: 'paid', trialEndsAt: null, sounds: [{ key: 'rain', label: 'Rain', available: true }], binaural: 'none', kirisTotal: null };
		plugin.settings.sound = 'kiri:rain';
		let finish: (v: unknown) => void = () => undefined;
		priv.soundCache.ensure = () => new Promise((resolve) => (finish = resolve));
		const played = vi.fn(async () => undefined);
		priv.sound.playRecording = played;
		plugin.startFocus();
		expect(plugin.soundLoading).toBe('rain');
		internals.unload();
		finish({ kind: 'file', path: 'sounds/rain.mp3' });
		await flush();
		expect(played).not.toHaveBeenCalled();
	});
});

describe('data.json shared with a connected device (review 2, code S3)', () => {
	it('a device without the connection keeps the other device\'s account in data.json', async () => {
		const other = { connectionId: 'conn-aaaa-1111', name: 'Sam' };
		const { plugin, internals } = await setup({ [NOTE]: '- [ ] A\n' }, { account: other });
		expect(plugin.account.connected).toBe(false);
		plugin.setVolume(20);
		plugin.addToToday(task(NOTE, 0, '- [ ] A'));
		await flush();
		expect(internals.stored?.account).toEqual(other);
	});
});

describe('a block running when Obsidian closes (review 2, code S4)', () => {
	async function start(fake: FakeApp): Promise<{ plugin: KiriPlugin; internals: Internals }> {
		const plugin = new KiriPlugin(fake as never, { id: 'kiri-focus-timer', version: '0.3.1', dir: '.obsidian/plugins/kiri-focus-timer' } as never);
		const internals = plugin as unknown as Internals;
		internals.stored = { chime: false, taskCounter: true };
		await plugin.onload();
		fake.readyLayout();
		await flush();
		return { plugin, internals };
	}

	it('resumes after a restart, with its task, and is logged once when it ends', async () => {
		fakeVersion.current = '1.12.0';
		const fake = new FakeApp();
		fake.files.set(NOTE, '- [ ] Write\n');
		const first = await start(fake);
		first.plugin.selectTask(task(NOTE, 0, '- [ ] Write'));
		first.plugin.startFocus();
		pass(first.internals, at(9, 10));
		first.internals.unload();

		vi.setSystemTime(at(9, 12));
		const second = await start(fake);
		expect(second.plugin.timer.phase).toBe('focus');
		expect(second.plugin.timer.startedAt).toBe(at(9, 0).getTime());
		expect(second.plugin.picked?.raw).toBe('- [ ] Write');
		expect(notices.some((n) => n.startsWith('Kiri resumed your focus block (13:00 left)'))).toBe(true);
		pass(second.internals, at(9, 25));
		await flush();
		expect(fake.files.get(LOG)).toBe('## Focus log\n- 2026-11-16 09:00–09:25 · Focus · [[Plan]] · Write\n');
		expect(fake.files.get(NOTE)).toBe('- [ ] Write [kiri:: 1]\n');
		fakeVersion.current = '1.10.0';
	});

	it('a paused block stays paused, and a stopped one is gone', async () => {
		fakeVersion.current = '1.12.0';
		const fake = new FakeApp();
		const first = await start(fake);
		first.plugin.startFocus();
		pass(first.internals, at(9, 5));
		first.plugin.togglePause();
		first.internals.unload();
		const second = await start(fake);
		expect(second.plugin.timer).toMatchObject({ phase: 'focus', running: false, remainingMs: 20 * 60_000 });
		second.plugin.stop();
		second.internals.unload();
		const third = await start(fake);
		expect(third.plugin.timer.phase).toBe('idle');
		fakeVersion.current = '1.10.0';
	});

	it('a damaged saved block is ignored', async () => {
		fakeVersion.current = '1.12.0';
		const fake = new FakeApp();
		fake.saveLocalStorage('kiri-focus-timer-block', { timer: { phase: 'focus', running: true, minutes: 'x' } });
		const { plugin } = await start(fake);
		expect(plugin.timer.phase).toBe('idle');
		fakeVersion.current = '1.10.0';
	});
});

describe('the tick interval (review 2, code N3)', () => {
	it('ticks once a minute when idle and twice a second while a block or break runs', async () => {
		const { plugin, internals } = await setup({});
		expect(plugin.tickPeriod).toBe(60_000);
		plugin.startFocus();
		expect(plugin.tickPeriod).toBe(500);
		pass(internals, at(9, 25));
		expect(plugin.timer.phase).toBe('break');
		expect(plugin.tickPeriod).toBe(500);
		pass(internals, at(9, 30));
		expect(plugin.timer.phase).toBe('idle');
		expect(plugin.tickPeriod).toBe(60_000);
	});
});

describe('note safety nice-to-haves (review 2)', () => {
	function menuTitles(fake: FakeApp, text: string, line: number): string[] {
		const titles: string[] = [];
		const item = {
			setTitle: (t: string) => (titles.push(t), item),
			setIcon: () => item,
			setDisabled: () => item,
			onClick: () => item,
		};
		const menu = { addItem: (fn: (i: typeof item) => void) => fn(item) };
		const editor = { getCursor: () => ({ line }), getLine: (n: number) => text.split('\n')[n] ?? '', getValue: () => text };
		fake.workspaceEvents.trigger('editor-menu', menu, editor, { file: fake.vault.getFileByPath(NOTE) });
		return titles;
	}

	it('"Focus on this task" is not offered for a - [ ] line inside a code block (N5)', async () => {
		const text = '- [ ] Real\n```\n- [ ] Example\n```\n';
		const { fake } = await setup({ [NOTE]: text });
		// The fake metadata cache lists every list line, so take the code block's line out as Obsidian does.
		const cache = fake.metadataCache.getFileCache;
		fake.metadataCache.getFileCache = (f) => {
			const c = cache(f);
			return { ...c, listItems: c.listItems.filter((i) => i.position.start.line !== 2) };
		};
		expect(menuTitles(fake, text, 0)).toContain('Focus on this task');
		expect(menuTitles(fake, text, 2)).toEqual([]);
	});

	it('a Tasks answer that would delete the line ticks it instead (🏁 delete)', async () => {
		const raw = '- [ ] Once 🏁 delete';
		const { fake, plugin } = await setup({ [NOTE]: `${raw}\n- [ ] Next\n` });
		fake.plugins = {
			enabledPlugins: new Set(['obsidian-tasks-plugin']),
			plugins: { 'obsidian-tasks-plugin': { apiV1: { executeToggleTaskDoneCommand: () => '' } } },
		};
		plugin.addToToday(task(NOTE, 0, raw));
		expect(await plugin.completeTodayItem(plugin.today.items[0]!)).toBe(true);
		expect(fake.files.get(NOTE)).toBe('- [x] Once 🏁 delete\n- [ ] Next\n');
	});
});

describe('the chosen break length', () => {
	it('is used after any block, and a running break keeps its length', async () => {
		const { plugin, internals } = await setup({}, { focusMinutes: 50, longBreakEnabled: false });
		plugin.setBreakMinutes(17);
		plugin.startFocus();
		pass(internals, at(9, 50));
		expect(plugin.timer).toMatchObject({ phase: 'break', minutes: 17 });
		plugin.setBreakMinutes(5);
		expect(plugin.timer.minutes).toBe(17);
		pass(internals, at(10, 7));
		plugin.startFocus();
		pass(internals, at(10, 57));
		expect(plugin.timer).toMatchObject({ phase: 'break', minutes: 5 });
		expect(internals.stored?.breakMinutes).toBe(5);
	});

	it('updates a waiting regular break, also after a restart', async () => {
		fakeVersion.current = '1.12.0';
		const fake = new FakeApp();
		const open = async (): Promise<{ plugin: KiriPlugin; internals: Internals }> => {
			const plugin = new KiriPlugin(fake as never, { id: 'kiri-focus-timer', version: '0.3.3', dir: '.obsidian/plugins/kiri-focus-timer' } as never);
			const internals = plugin as unknown as Internals;
			internals.stored = { chime: false, autoStartBreak: false, focusMinutes: 50 };
			await plugin.onload();
			fake.readyLayout();
			await flush();
			return { plugin, internals };
		};
		const first = await open();
		first.plugin.startFocus();
		pass(first.internals, at(9, 50));
		expect(first.plugin.pendingBreak).toEqual({ minutes: 10, isLong: false, blockMinutes: 50 });
		first.plugin.setBreakMinutes(17);
		expect(first.plugin.pendingBreak?.minutes).toBe(17);
		first.internals.unload();

		const second = await open();
		expect(second.plugin.pendingBreak).toEqual({ minutes: 17, isLong: false, blockMinutes: 50 });
		// Back to Auto: by the 50-minute block it follows.
		second.plugin.setBreakMinutes(null);
		expect(second.plugin.pendingBreak?.minutes).toBe(10);
		expect(second.plugin.autoBreakMinutes()).toBe(10);
		second.plugin.startBreak();
		expect(second.plugin.timer).toMatchObject({ phase: 'break', minutes: 10 });
		fakeVersion.current = '1.10.0';
	});

	it('leaves a waiting long break alone', async () => {
		const { plugin, internals } = await setup({}, { autoStartBreak: false, longBreakEvery: 2, longBreakMinutes: 20, autoStartNext: false });
		plugin.startFocus();
		pass(internals, at(9, 25));
		plugin.startFocus();
		pass(internals, at(9, 50));
		expect(plugin.pendingBreak).toMatchObject({ minutes: 20, isLong: true });
		plugin.setBreakMinutes(5);
		expect(plugin.pendingBreak).toMatchObject({ minutes: 20, isLong: true });
	});
});
