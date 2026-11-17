/**
 * The "Today" list: tasks picked from any notes to work through in order.
 * The first item is the current task (the one the timer works on).
 * Pure functions only; nothing here touches the vault.
 */
import { copyOf, type LineCopy, locateLine, metadataStart, parseTaskLine, plainTaskText } from './taskLine';

/** Most tasks the Today list holds. */
export const MAX_TODAY = 30;

/** A task on the Today list. Same shape as a task item from the vault. */
export interface TodayItem {
	path: string;
	/** Line number when last seen; a hint only, lines move. */
	line: number;
	/** The full line when last seen, used to find it again. */
	raw: string;
	text: string;
	noteName: string;
	/**
	 * Set when the task could not be found in its note the last time Kiri
	 * looked (edited beyond recognition, its note deleted). Shown on the row.
	 */
	stale?: boolean;
	/** Which of several identical lines in the note this is (see locateLine). */
	copy?: number;
	copies?: number;
}

export interface TodayState {
	/** Local date (YYYY-MM-DD) the list belongs to. */
	day: string;
	items: TodayItem[];
}

/** Same task: same note and same line text. */
export function sameTask(a: { path: string; raw: string }, b: { path: string; raw: string }): boolean {
	return a.path === b.path && a.raw === b.raw;
}

export function indexOfTask(items: readonly TodayItem[], task: { path: string; raw: string }): number {
	return items.findIndex((i) => sameTask(i, task));
}

export type AddResult = 'added' | 'duplicate' | 'full';

/** Add a task at the end (or the front). A task already on the list is not added twice. */
export function addToToday(
	items: readonly TodayItem[],
	task: TodayItem,
	where: 'end' | 'front' = 'end',
): { items: TodayItem[]; result: AddResult } {
	if (indexOfTask(items, task) !== -1) return { items: [...items], result: 'duplicate' };
	if (items.length >= MAX_TODAY) return { items: [...items], result: 'full' };
	const item = copyItem(task);
	return { items: where === 'front' ? [item, ...items] : [...items, item], result: 'added' };
}

/** Add several tasks in order, skipping ones already there and stopping when the list is full. */
export function addManyToToday(
	items: readonly TodayItem[],
	tasks: readonly TodayItem[],
): { items: TodayItem[]; added: number; full: boolean } {
	let next = [...items];
	let added = 0;
	let full = false;
	for (const task of tasks) {
		const r = addToToday(next, task);
		next = r.items;
		if (r.result === 'added') added++;
		if (r.result === 'full') {
			full = true;
			break;
		}
	}
	return { items: next, added, full };
}

/**
 * Make a task the current one: move it to the front, or add it there.
 * Returns the list unchanged with result 'full' when it is not on a full list.
 */
export function makeCurrent(items: readonly TodayItem[], task: TodayItem): { items: TodayItem[]; result: AddResult } {
	const i = indexOfTask(items, task);
	if (i !== -1) return { items: moveItem(items, i, 0), result: 'duplicate' };
	return addToToday(items, task, 'front');
}

/** Move the item at `from` to `to` (both clamped to the list). */
export function moveItem(items: readonly TodayItem[], from: number, to: number): TodayItem[] {
	const next = [...items];
	if (from < 0 || from >= next.length) return next;
	const target = Math.max(0, Math.min(next.length - 1, to));
	const [item] = next.splice(from, 1);
	if (item) next.splice(target, 0, item);
	return next;
}

export function removeAt(items: readonly TodayItem[], index: number): TodayItem[] {
	return items.filter((_, i) => i !== index);
}

export function removeTask(items: readonly TodayItem[], task: { path: string; raw: string }): TodayItem[] {
	return items.filter((i) => !sameTask(i, task));
}

/** Change the items for which `fn` returns a new item; the others stay as they are. */
export function mapItems(items: readonly TodayItem[], fn: (item: TodayItem) => TodayItem | null): { items: TodayItem[]; changed: boolean } {
	let changed = false;
	const next = items.map((i) => {
		const r = fn(i);
		if (!r) return i;
		changed = true;
		return copyItem(r);
	});
	return { items: next, changed };
}

/**
 * Follow a renamed or moved note (or folder): items in it get the new path and note name.
 * `oldPath` is a file path, or a folder path whose files all moved.
 */
export function renamePath(items: readonly TodayItem[], oldPath: string, newPath: string, isFolder: boolean): { items: TodayItem[]; changed: boolean } {
	return mapItems(items, (i) => {
		const moved = movedPath(i.path, oldPath, newPath, isFolder);
		return moved === null ? null : { ...i, path: moved, noteName: noteNameOf(moved) };
	});
}

/** The new path of `path` after `oldPath` became `newPath`, or null when it did not move. */
export function movedPath(path: string, oldPath: string, newPath: string, isFolder: boolean): string | null {
	if (!isFolder) return path === oldPath ? newPath : null;
	return path.startsWith(`${oldPath}/`) ? `${newPath}/${path.slice(oldPath.length + 1)}` : null;
}

/** True when `path` is the deleted file, or inside the deleted folder. */
export function isUnder(path: string, deleted: string, isFolder: boolean): boolean {
	return isFolder ? path.startsWith(`${deleted}/`) : path === deleted;
}

/** Note name shown for a path: the file name without `.md`. */
export function noteNameOf(path: string): string {
	const name = path.split('/').pop() ?? path;
	return name.replace(/\.md$/i, '');
}

/**
 * The item at `line`, as copy `copy.copy` of `copy.copies` identical lines.
 * The copy fields are kept only when there is more than one copy.
 */
export function atPlace<T extends TodayItem>(item: T, line: number, copy: LineCopy): T {
	const next: T = { ...item, line };
	delete next.copy;
	delete next.copies;
	if (copy.copies > 1) {
		next.copy = copy.copy;
		next.copies = copy.copies;
	}
	return next;
}

/** True when the item is already at `line` as the same copy. */
export function samePlace(item: TodayItem, line: number, copy: LineCopy): boolean {
	const known = item.copies !== undefined && item.copies > 1;
	if (item.line !== line) return false;
	return copy.copies > 1 ? known && item.copy === copy.copy && item.copies === copy.copies : !known;
}

/** Point an item at its new line after Kiri edited it (e.g. added [spent::]). */
export function replaceTask(items: readonly TodayItem[], old: { path: string; raw: string }, next: TodayItem): TodayItem[] {
	return items.map((i) => (sameTask(i, old) ? copyItem(next) : i));
}

/**
 * Start a new list on a new day, unless the list is kept across days.
 * A kept list moves to today's date. A date earlier than the list's (the clock
 * was set back, or after flying west) changes nothing.
 */
export function resetIfNewDay(state: TodayState, today: string, keep: boolean): TodayState {
	// YYYY-MM-DD strings compare in date order.
	if (today <= state.day) return state;
	return { day: today, items: keep ? state.items : [] };
}

/** Read the saved list, skipping anything malformed. */
export function parseTodayState(value: unknown, today: string): TodayState {
	if (!value || typeof value !== 'object') return { day: today, items: [] };
	const v = value as { day?: unknown; items?: unknown };
	const day = typeof v.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.day) ? v.day : today;
	const items: TodayItem[] = [];
	if (Array.isArray(v.items)) {
		for (const raw of v.items) {
			if (!raw || typeof raw !== 'object') continue;
			const i = raw as Partial<Record<keyof TodayItem, unknown>>;
			if (typeof i.path !== 'string' || typeof i.raw !== 'string' || !parseTaskLine(i.raw)) continue;
			const item: TodayItem = {
				path: i.path,
				line: typeof i.line === 'number' && Number.isInteger(i.line) && i.line >= 0 ? i.line : 0,
				raw: i.raw,
				text: typeof i.text === 'string' ? i.text : (parseTaskLine(i.raw)?.text ?? ''),
				noteName: typeof i.noteName === 'string' ? i.noteName : '',
			};
			if (i.stale === true) item.stale = true;
			if (isCount(i.copies) && i.copies > 1 && isCount(i.copy) && i.copy < i.copies) {
				item.copy = i.copy;
				item.copies = i.copies;
			}
			if (indexOfTask(items, item) === -1) items.push(item);
			if (items.length >= MAX_TODAY) break;
		}
	}
	return { day, items };
}

// Where a Today item is now

export type Whereabouts =
	/** The line is there as it was (maybe at another line number). */
	| { kind: 'same'; line: number; copy: LineCopy }
	/** The task is still open, but its line changed (a field was added, for example). */
	| { kind: 'changed'; line: number; raw: string; text: string; copy: LineCopy }
	/** The task was ticked done (or cancelled) in the note. `raw` is the closed line. */
	| { kind: 'done'; line: number; raw: string; copy: LineCopy }
	/** Not found: deleted, or edited beyond recognition. */
	| { kind: 'missing' };

const CLOSED = new Set(['x', 'X', '-']);
const DONE_DATE_RE = /\s*(?:✅|❌)️?\s*\d{4}-\d{2}-\d{2}/g;
const DONE_FIELD_RE = /\s*[[(](?:completion|cancelled)::[^\])]*[\])]/g;
/** A Tasks recurrence rule, in emoji or Dataview format. Only such tasks get a new line when ticked. */
const RECURRING_RE = /🔁|[[(]repeat::/;

/**
 * What identifies a task line whatever its status: the list marker and
 * indentation, the words, and the set of trailing Tasks fields in any order
 * (the Tasks plugin may write them in its own order when it ticks a task),
 * without the done or cancelled date ticking adds.
 */
function lineSignature(line: string): string | null {
	const parsed = parseTaskLine(line);
	if (!parsed) return null;
	const text = parsed.text.replace(DONE_DATE_RE, '').replace(DONE_FIELD_RE, '').replace(/\s+$/, '');
	const cut = metadataStart(text);
	const head = text.slice(0, cut).replace(/\s+/g, ' ').trim();
	const fields = text.slice(cut).trim().split(/\s+/).filter((t) => t.length > 0).sort();
	return `${parsed.prefix}\n${head}\n${fields.join(' ')}`;
}

function isClosed(line: string | undefined): boolean {
	const parsed = line === undefined ? null : parseTaskLine(line);
	return !!parsed && CLOSED.has(parsed.status);
}

function isOpenWith(line: string | undefined, words: string): boolean {
	const parsed = line === undefined ? null : parseTaskLine(line);
	return !!parsed && parsed.status === ' ' && plainTaskText(parsed.text) === words;
}

/**
 * Find a Today item in the current text of its note.
 * 1. The exact line, if it can be told apart from identical lines (see locateLine).
 * 2. The item's own line ticked done (or cancelled), possibly with a Tasks done
 *    date and its fields reordered. Only the line where the item was counts, so
 *    an older completed copy of the same task elsewhere in the note is never
 *    taken for it. A recurring task ticked by the Tasks plugin may instead be
 *    one line further down, under its new open occurrence.
 *    When `previousLineCount` is known, the note must have the same number of
 *    lines as before (one more for a recurring task): a deleted line that let
 *    another line move into the item's place is not a tick.
 *    A stale item (one that was not found before) is never taken as ticked: its
 *    line may have been deleted and another moved into its place since.
 * 3. One open task with the same words (fields such as dates or [spent::] changed).
 * Keep `item.line` up to date (also on 'same') for step 2 to work.
 */
export function locateTodayItem(item: TodayItem, lines: readonly string[], previousLineCount?: number): Whereabouts {
	const exact = locateLine(lines, item.raw, item);
	if (exact !== -1) return { kind: 'same', line: exact, copy: copyOf(lines, exact) };

	const wanted = lineSignature(item.raw);
	const words = plainTaskText(parseTaskLine(item.raw)?.text ?? '');
	const recurring = RECURRING_RE.test(item.raw);
	const grew = previousLineCount === undefined ? null : lines.length - previousLineCount;
	const isTick = (i: number): boolean => isClosed(lines[i]) && lineSignature(lines[i] ?? '') === wanted;
	if (wanted !== null && !item.stale) {
		const L = item.line;
		if ((grew === null || grew === 0 || (recurring && grew === 1)) && isTick(L)) {
			return { kind: 'done', line: L, raw: lines[L] ?? '', copy: copyOf(lines, L) };
		}
		// Tasks puts the new occurrence of a recurring task above the ticked one (its default).
		if (recurring && (grew === null || grew === 1) && isTick(L + 1) && isOpenWith(lines[L], words)) {
			return { kind: 'done', line: L + 1, raw: lines[L + 1] ?? '', copy: copyOf(lines, L + 1) };
		}
	}

	if (!words) return { kind: 'missing' };
	const open: number[] = [];
	lines.forEach((l, i) => {
		if (isOpenWith(l, words)) open.push(i);
	});
	if (open.length === 1 && open[0] !== undefined) {
		const line = open[0];
		const raw = lines[line] ?? '';
		return { kind: 'changed', line, raw, text: parseTaskLine(raw)?.text ?? '', copy: copyOf(lines, line) };
	}
	return { kind: 'missing' };
}

// Splitting a focus block between tasks

/** Focus time of the running block so far, in ms (pauses excluded). */
export function focusElapsedMs(blockMinutes: number, remainingMs: number): number {
	return Math.max(0, Math.min(blockMinutes * 60_000, blockMinutes * 60_000 - remainingMs));
}

/**
 * The part of a block that belongs to a task finished partway through it:
 * from the end of the previous part (or the start) until now, in whole minutes.
 */
export function takeSegment(elapsedMs: number, segmentStartMs: number): { minutes: number; nextStartMs: number } {
	const ms = Math.max(0, elapsedMs - segmentStartMs);
	return { minutes: Math.round(ms / 60_000), nextStartMs: Math.max(segmentStartMs, elapsedMs) };
}

/**
 * Parts of the running focus block already given to tasks: to tasks ticked
 * done during it, and to tasks that stopped being the current one (switched
 * away from, moved down, removed from Today).
 */
export interface BlockSplit<T extends TodayItem = TodayItem> {
	/** Focus ms into the block where the current task's part started. */
	startMs: number;
	/** Minutes given to each earlier part, in order (finished and switched tasks alike). */
	given: number[];
	/** The tasks finished (ticked done) during the block, in order. Switched tasks are not here. */
	finished: T[];
}

export const NO_SPLIT: BlockSplit = { startMs: 0, given: [], finished: [] };

/**
 * Close the part of the block that belongs to the task that was current until
 * now: it gets the time since the previous part ended, in whole minutes, and
 * the next part starts now. `done` is true when the task was ticked done (it
 * then joins `finished`, which the log line may name); false when the user
 * only switched away from it. A part shorter than half a minute is 0 minutes:
 * nothing is written for it, and its seconds stay with the rest of the block.
 */
export function closePart<T extends TodayItem>(split: BlockSplit<T>, elapsedMs: number, task: T, done: boolean): { split: BlockSplit<T>; minutes: number } {
	const part = takeSegment(elapsedMs, split.startMs);
	return {
		minutes: part.minutes,
		split: {
			startMs: part.nextStartMs,
			given: [...split.given, part.minutes],
			finished: done ? [...split.finished, task] : [...split.finished],
		},
	};
}

/**
 * "Next task": the current task (the first) goes to the end of the list, still
 * open, and the second becomes current. With fewer than two tasks nothing moves.
 */
export function currentToEnd(items: readonly TodayItem[]): TodayItem[] {
	return items.length < 2 ? [...items] : moveItem(items, 0, items.length - 1);
}

/** True when the current task is a different one after a change (or there is none any more). */
export function currentChanged(before: { path: string; raw: string } | null, after: { path: string; raw: string } | null): boolean {
	return before !== null && (after === null || !sameTask(before, after));
}

/** What is left of the block for the task current at its end, after the parts already given out. */
export function remainingMinutes(blockMinutes: number, givenMinutes: readonly number[]): number {
	const given = givenMinutes.reduce((a, b) => a + b, 0);
	return Math.max(0, blockMinutes - given);
}

function copyItem(task: TodayItem): TodayItem {
	const item: TodayItem = { path: task.path, line: task.line, raw: task.raw, text: task.text, noteName: task.noteName };
	if (task.stale) item.stale = true;
	// Only worth keeping when the note has the line more than once.
	if (task.copies !== undefined && task.copies > 1 && task.copy !== undefined) {
		item.copy = task.copy;
		item.copies = task.copies;
	}
	return item;
}

function isCount(v: unknown): v is number {
	return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
