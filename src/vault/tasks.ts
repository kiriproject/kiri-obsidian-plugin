import type { App, TFile } from 'obsidian';
import { copyOf, incrementCounter, isOpenTask, markDonePlain, parseTaskLine, replaceLine, splitLines, withoutKiriCounters } from '../logic/taskLine';

/**
 * Where a task lives. `raw` is the full line, used to find it again before any
 * edit. When the note holds the same line more than once, `copy` and `copies`
 * say which one it is (see locateLine); without them such a task is never edited.
 */
export interface TaskRef {
	path: string;
	line: number;
	raw: string;
	copy?: number;
	copies?: number;
}

export interface TaskItem extends TaskRef {
	/** The text after `- [ ] `, shown as is (Tasks plugin emoji included). */
	text: string;
	/** Note name without extension, for display. */
	noteName: string;
}

export const VAULT_TASK_LIMIT = 100;

/**
 * True for a board of the Kanban plugin (frontmatter `kanban-plugin`). Its
 * cards are `- [ ]` lines, but the board owns them: Kiri never lists them as
 * tasks and never edits a board.
 */
export function isKanbanBoard(app: App, file: TFile): boolean {
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
	return !!frontmatter && frontmatter['kanban-plugin'] !== undefined;
}

function hasOpenTasks(app: App, file: TFile): boolean {
	if (isKanbanBoard(app, file)) return false;
	const items = app.metadataCache.getFileCache(file)?.listItems;
	return !!items && items.some((i) => i.task === ' ');
}

/** Open tasks in one note, in line order. */
export async function openTasksInFile(app: App, file: TFile): Promise<TaskItem[]> {
	if (isKanbanBoard(app, file)) return [];
	const items = app.metadataCache.getFileCache(file)?.listItems?.filter((i) => i.task === ' ') ?? [];
	if (items.length === 0) return [];
	const { lines } = splitLines(await app.vault.cachedRead(file));
	const out: TaskItem[] = [];
	for (const item of items) {
		const lineNo = item.position.start.line;
		const raw = lines[lineNo];
		if (raw === undefined || !isOpenTask(raw)) continue;
		const parsed = parseTaskLine(raw);
		if (!parsed || parsed.text.trim().length === 0) continue;
		out.push({ path: file.path, line: lineNo, raw, text: parsed.text, noteName: file.basename, ...copyOf(lines, lineNo) });
	}
	return out;
}

/** Text match on the task and its note name. */
export function matchesQuery(task: TaskItem, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return task.text.toLowerCase().includes(q) || task.noteName.toLowerCase().includes(q);
}

/**
 * Open tasks per note, kept between scans of "All notes". An entry is used
 * while the note's modified time is unchanged; the view also drops it when
 * Obsidian reports the note changed, renamed or deleted.
 */
export class TaskCache {
	private readonly entries = new Map<string, { mtime: number; tasks: TaskItem[] }>();

	get(file: TFile): TaskItem[] | null {
		const entry = this.entries.get(file.path);
		return entry && entry.mtime === file.stat.mtime ? entry.tasks : null;
	}

	set(file: TFile, tasks: TaskItem[]): void {
		this.entries.set(file.path, { mtime: file.stat.mtime, tasks });
	}

	invalidate(path: string): void {
		this.entries.delete(path);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

export interface VaultScanOptions {
	limit?: number;
	/** Reuse and fill this cache, so a new query reads only notes that changed. */
	cache?: TaskCache;
	/** Checked before each note is read: true stops the scan (a newer one started). */
	isStale?: () => boolean;
}

/**
 * Open tasks across the vault, most recently edited notes first.
 * Only notes whose metadata cache lists an open task are read (never Kanban
 * boards). Stops at `limit` results. Returns null when stopped by `isStale`.
 */
export async function openTasksInVault(
	app: App,
	query: string,
	options: VaultScanOptions = {},
): Promise<{ tasks: TaskItem[]; capped: boolean } | null> {
	const limit = options.limit ?? VAULT_TASK_LIMIT;
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => hasOpenTasks(app, f))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
	const tasks: TaskItem[] = [];
	for (const file of files) {
		let inFile = options.cache?.get(file) ?? null;
		if (!inFile) {
			if (options.isStale?.()) return null;
			inFile = await openTasksInFile(app, file);
			if (options.isStale?.()) return null;
			options.cache?.set(file, inFile);
		}
		for (const task of inFile) {
			if (!matchesQuery(task, query)) continue;
			tasks.push(task);
			if (tasks.length >= limit) return { tasks, capped: true };
		}
	}
	return { tasks, capped: false };
}

/**
 * Change one task line atomically with Vault.process.
 * The line is found again by its exact text (and, for identical lines, by which copy it is),
 * so edits made since it was picked are safe. Returns the updated reference (pointing at the
 * first replaced line) or null if the line is gone or cannot be told apart from an identical one.
 */
export async function updateTaskLine(app: App, ref: TaskRef, transform: (line: string) => string | null): Promise<TaskRef | null> {
	const file = app.vault.getFileByPath(ref.path);
	if (!file || isKanbanBoard(app, file)) return null;
	// The line is matched by its exact text, so the transform can work on ref.raw.
	const next = transform(ref.raw);
	if (next === null) return null;
	let result: TaskRef | null = null;
	await app.vault.process(file, (data) => {
		const replaced = replaceLine(data, ref.raw, next, ref);
		if (!replaced) return data;
		result = { path: ref.path, line: replaced.index, raw: next.split(/\r?\n/)[0] ?? next, ...replaced.copy };
		return replaced.content;
	});
	return result;
}

export function addBlockToCounter(app: App, ref: TaskRef): Promise<TaskRef | null> {
	return updateTaskLine(app, ref, incrementCounter);
}

interface TasksApiV1 {
	executeToggleTaskDoneCommand: (line: string, path: string) => string;
}

interface AppWithPlugins {
	plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, { apiV1?: TasksApiV1 } | undefined> };
}

/** The Tasks plugin API, if that plugin is installed and on. */
export function getTasksApi(app: App): TasksApiV1 | null {
	const plugins = (app as unknown as AppWithPlugins).plugins;
	if (!plugins?.enabledPlugins?.has('obsidian-tasks-plugin')) return null;
	const api = plugins.plugins?.['obsidian-tasks-plugin']?.apiV1;
	return api && typeof api.executeToggleTaskDoneCommand === 'function' ? api : null;
}

/**
 * Mark a task done: through the Tasks plugin when present, otherwise `[ ]` becomes `[x]`.
 * `after` can change the completed line in the same edit (for example to add the
 * minutes spent on it); when it returns null the line is kept as it is.
 *
 * With the Tasks plugin, a recurring task comes back as two lines: the
 * completed one and a new open occurrence built from the same text. The open
 * line is ticked first and `after` is applied to the completed line only, so
 * the new occurrence never inherits this occurrence's time; Kiri's own
 * `[kiri::]` and `[spent::]` fields are also taken off the new occurrence.
 */
export function markTaskDone(app: App, ref: TaskRef, after?: (line: string) => string | null): Promise<TaskRef | null> {
	const api = getTasksApi(app);
	return updateTaskLine(app, ref, (original) => {
		if (!isOpenTask(original)) return null;
		if (api) {
			const toggled = api.executeToggleTaskDoneCommand(original, ref.path);
			// An empty answer means "delete the line" (Tasks' 🏁 delete). Kiri never deletes a line: it ticks it instead.
			if (typeof toggled === 'string' && toggled !== original && toggled.trim().length > 0) return finishToggled(toggled, after);
		}
		const done = markDonePlain(original);
		if (done === null) return null;
		return after?.(done) ?? done;
	});
}

/** Apply `after` to the completed line of a Tasks result; clear Kiri's counters on new open occurrences. */
export function finishToggled(toggled: string, after?: (line: string) => string | null): string {
	const lines = toggled.split(/\r?\n/);
	const eol = toggled.includes('\r\n') ? '\r\n' : '\n';
	let doneSeen = false;
	const out = lines.map((line) => {
		const parsed = parseTaskLine(line);
		if (!parsed) return line;
		if (parsed.status === ' ') return lines.length > 1 ? withoutKiriCounters(line) : line;
		if (doneSeen) return line;
		doneSeen = true;
		return after?.(line) ?? line;
	});
	return out.join(eol);
}
