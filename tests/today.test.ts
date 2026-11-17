import { describe, expect, it } from 'vitest';
import {
	atPlace,
	closePart,
	currentChanged,
	currentToEnd,
	NO_SPLIT,
	samePlace,
	addManyToToday,
	addToToday,
	focusElapsedMs,
	locateTodayItem,
	makeCurrent,
	MAX_TODAY,
	moveItem,
	parseTodayState,
	remainingMinutes,
	removeAt,
	removeTask,
	renamePath,
	replaceTask,
	resetIfNewDay,
	takeSegment,
	type TodayItem,
} from '../src/logic/today';

function item(text: string, path = 'Plan.md', line = 0): TodayItem {
	return { path, line, raw: `- [ ] ${text}`, text, noteName: path.replace(/\.md$/, '') };
}

const texts = (items: TodayItem[]): string[] => items.map((i) => i.text);

describe('Today list', () => {
	it('adds tasks from any notes, in order, and never twice', () => {
		let items: TodayItem[] = [];
		items = addToToday(items, item('A')).items;
		items = addToToday(items, item('B', 'Other.md')).items;
		const again = addToToday(items, item('A'));
		expect(again.result).toBe('duplicate');
		expect(texts(again.items)).toEqual(['A', 'B']);
		// Same words in another note is another task.
		expect(addToToday(items, item('A', 'Other.md')).result).toBe('added');
	});

	it(`stops at ${MAX_TODAY} tasks`, () => {
		const many = Array.from({ length: MAX_TODAY + 5 }, (_, i) => item(`T${i}`));
		const r = addManyToToday([], many);
		expect(r.items).toHaveLength(MAX_TODAY);
		expect(r.added).toBe(MAX_TODAY);
		expect(r.full).toBe(true);
		expect(addToToday(r.items, item('one more')).result).toBe('full');
	});

	it('adds many, skipping ones already there', () => {
		const r = addManyToToday([item('A')], [item('A'), item('B'), item('C')]);
		expect(texts(r.items)).toEqual(['A', 'B', 'C']);
		expect(r.added).toBe(2);
		expect(r.full).toBe(false);
	});

	it('reorders, clamping to the list', () => {
		const items = [item('A'), item('B'), item('C')];
		expect(texts(moveItem(items, 2, 0))).toEqual(['C', 'A', 'B']);
		expect(texts(moveItem(items, 0, 1))).toEqual(['B', 'A', 'C']);
		expect(texts(moveItem(items, 1, -4))).toEqual(['B', 'A', 'C']);
		expect(texts(moveItem(items, 0, 99))).toEqual(['B', 'C', 'A']);
		expect(texts(moveItem(items, 7, 0))).toEqual(['A', 'B', 'C']);
	});

	it('removes by position or by task', () => {
		const items = [item('A'), item('B'), item('C')];
		expect(texts(removeAt(items, 1))).toEqual(['A', 'C']);
		expect(texts(removeTask(items, item('C')))).toEqual(['A', 'B']);
	});

	it('completing the current task makes the next one current', () => {
		const items = [item('A'), item('B')];
		const after = removeTask(items, items[0]!);
		expect(after[0]?.text).toBe('B');
	});

	it('makes a task current by moving or adding it to the front', () => {
		const items = [item('A'), item('B')];
		expect(texts(makeCurrent(items, item('B')).items)).toEqual(['B', 'A']);
		expect(texts(makeCurrent(items, item('C')).items)).toEqual(['C', 'A', 'B']);
		const full = Array.from({ length: MAX_TODAY }, (_, i) => item(`T${i}`));
		expect(makeCurrent(full, item('new')).result).toBe('full');
	});

	it('follows a task after Kiri edits its line', () => {
		const items = [item('A'), item('B')];
		const edited = { ...item('B [spent:: 25m]'), text: 'B [spent:: 25m]' };
		expect(replaceTask(items, item('B'), edited)[1]?.raw).toBe('- [ ] B [spent:: 25m]');
	});

	it('starts empty on a new day unless kept', () => {
		const state = { day: '2026-11-15', items: [item('A')] };
		expect(resetIfNewDay(state, '2026-11-15', false)).toBe(state);
		expect(resetIfNewDay(state, '2026-11-16', false)).toEqual({ day: '2026-11-16', items: [] });
		expect(resetIfNewDay(state, '2026-11-16', true)).toEqual({ day: '2026-11-16', items: state.items });
	});

	it('keeps the list when the date goes backwards (clock set back, flying west)', () => {
		const state = { day: '2026-11-17', items: [item('A')] };
		expect(resetIfNewDay(state, '2026-11-16', false)).toBe(state);
		expect(resetIfNewDay(state, '2025-12-31', false)).toBe(state);
		expect(resetIfNewDay(state, '2026-11-18', false).items).toEqual([]);
	});

	it('follows a renamed note or folder', () => {
		const items = [item('A', 'Old.md'), item('B', 'Projects/Plan.md'), item('C', 'Projects/Sub/Deep.md'), item('D', 'ProjectsX/Other.md')];
		const file = renamePath(items, 'Old.md', 'Archive/New name.md', false);
		expect(file.changed).toBe(true);
		expect(file.items[0]).toMatchObject({ path: 'Archive/New name.md', noteName: 'New name', raw: '- [ ] A' });
		expect(file.items.slice(1)).toEqual(items.slice(1));
		const folder = renamePath(items, 'Projects', 'Work', true);
		expect(folder.items.map((i) => i.path)).toEqual(['Old.md', 'Work/Plan.md', 'Work/Sub/Deep.md', 'ProjectsX/Other.md']);
		expect(renamePath(items, 'Nope.md', 'X.md', false).changed).toBe(false);
	});

	it('saves and reads the stale mark', () => {
		const parsed = parseTodayState({ day: '2026-11-16', items: [{ ...item('A'), stale: true }, { ...item('B'), stale: 'yes' }] }, '2026-11-16');
		expect(parsed.items.map((i) => i.stale)).toEqual([true, undefined]);
	});

	it('reads saved data defensively', () => {
		expect(parseTodayState(undefined, '2026-11-16')).toEqual({ day: '2026-11-16', items: [] });
		const parsed = parseTodayState(
			{
				day: '2026-11-15',
				items: [item('A'), item('A'), { path: 'x.md', raw: 'not a task' }, { raw: '- [ ] no path' }, 7, { path: 'P.md', raw: '- [ ] B', line: -3 }],
			},
			'2026-11-16',
		);
		expect(parsed.day).toBe('2026-11-15');
		expect(texts(parsed.items)).toEqual(['A', 'B']);
		expect(parsed.items[1]?.line).toBe(0);
		expect(parseTodayState({ day: 'yesterday' }, '2026-11-16').day).toBe('2026-11-16');
	});
});

describe('finding a Today item in its note', () => {
	const A = { ...item('Write intro'), line: 1 };

	it('finds the exact line, also after lines moved', () => {
		expect(locateTodayItem(A, ['# Plan', '- [ ] Write intro'])).toMatchObject({ kind: 'same', line: 1 });
		expect(locateTodayItem(A, ['# Plan', 'new', 'new', '- [ ] Write intro'])).toMatchObject({ kind: 'same', line: 3 });
	});

	it('sees a task ticked in the note, with or without a Tasks done date', () => {
		expect(locateTodayItem(A, ['# Plan', '- [x] Write intro'])).toMatchObject({ kind: 'done', line: 1, raw: '- [x] Write intro' });
		expect(locateTodayItem(A, ['# Plan', '- [x] Write intro ✅ 2026-11-16'])).toMatchObject({ kind: 'done' });
		expect(locateTodayItem(A, ['# Plan', '- [-] Write intro ❌ 2026-11-16'])).toMatchObject({ kind: 'done' });
	});

	it('sees a recurring task ticked by the Tasks plugin (new open line above the done one)', () => {
		const R = { ...item('Water plants 🔁 every day 📅 2026-11-16'), line: 1 };
		const lines = ['# Plan', '- [ ] Water plants 🔁 every day 📅 2026-11-17', '- [x] Water plants 🔁 every day 📅 2026-11-16 ✅ 2026-11-16'];
		expect(locateTodayItem(R, lines)).toMatchObject({ kind: 'done', line: 2, raw: lines[2] });
	});

	it('follows an open task whose fields changed', () => {
		expect(locateTodayItem(A, ['# Plan', '- [ ] Write intro [spent:: 25m] 📅 2026-11-20'])).toMatchObject({
			kind: 'changed',
			line: 1,
			raw: '- [ ] Write intro [spent:: 25m] 📅 2026-11-20',
			text: 'Write intro [spent:: 25m] 📅 2026-11-20',
		});
	});

	it('never takes an older completed copy elsewhere in the note for the item (review S1)', () => {
		const bob = { ...item('Email Bob'), line: 1 };
		const old = '- [x] Email Bob';
		// The open line was edited beyond its words: not done, not found.
		expect(locateTodayItem(bob, [old, '- [ ] Email Bob about the invoice'], 2)).toMatchObject({ kind: 'missing' });
		// Dated, given [spent::] or indented: followed as the same open task, not done.
		for (const edited of ['- [ ] Email Bob 📅 2026-11-20', '- [ ] Email Bob [spent:: 25m]', '\t- [ ] Email Bob']) {
			expect(locateTodayItem(bob, [old, edited], 2)).toMatchObject({ kind: 'changed', line: 1, raw: edited });
		}
		// The old copy below the item, and the item edited.
		const top = { ...item('Email Bob'), line: 0 };
		expect(locateTodayItem(top, ['- [ ] Email Bob 📅 2026-11-20', old], 2)).toMatchObject({ kind: 'changed', line: 0 });
	});

	it('does not take a deleted line for a tick when an older copy moves into its place', () => {
		const top = { ...item('Email Bob'), line: 0 };
		// The open line was deleted; the old done line moved up to line 0.
		expect(locateTodayItem(top, ['- [x] Email Bob', 'other'], 3)).toMatchObject({ kind: 'missing' });
		// The real tick, line count unchanged.
		expect(locateTodayItem(top, ['- [x] Email Bob', '- [x] Email Bob', 'other'], 3)).toMatchObject({ kind: 'done', line: 0, raw: '- [x] Email Bob' });
	});

	it('never takes a stale item for ticked (its line may be another one by now)', () => {
		const top = { ...item('Email Bob'), line: 0, stale: true };
		expect(locateTodayItem(top, ['- [x] Email Bob', 'other'], 2)).toMatchObject({ kind: 'missing' });
		expect(locateTodayItem(top, ['- [ ] Email Bob', 'other'], 2)).toMatchObject({ kind: 'same', line: 0 });
	});

	it('sees a tick whose Tasks fields were rewritten in another order (review N1)', () => {
		const X = { ...item('X 📅 2026-11-20 ⏫'), line: 0 };
		expect(locateTodayItem(X, ['- [x] X ⏫ 📅 2026-11-20 ✅ 2026-11-16'], 1)).toMatchObject({ kind: 'done', line: 0 });
	});

	it('sees a recurring task ticked by Tasks with its fields reordered, new occurrence above', () => {
		const R = { ...item('X 📅 2026-11-16 🔁 every day'), line: 0 };
		const lines = ['- [ ] X 🔁 every day 📅 2026-11-17', '- [x] X 🔁 every day 📅 2026-11-16 ✅ 2026-11-16'];
		expect(locateTodayItem(R, lines, 1)).toMatchObject({ kind: 'done', line: 1, raw: lines[1] });
		// New occurrence below (a Tasks setting).
		expect(locateTodayItem(R, [lines[1]!, lines[0]!], 1)).toMatchObject({ kind: 'done', line: 0, raw: lines[1] });
		// A task that does not recur never gets a second line: no "done" one line down.
		const plain = { ...item('Email Bob'), line: 0 };
		expect(locateTodayItem(plain, ['- [ ] Email Bob 📅 2026-11-20', '- [x] Email Bob'], 1)).toMatchObject({ kind: 'changed' });
	});

	it('reports missing when the task is gone or ambiguous', () => {
		expect(locateTodayItem(A, ['# Plan'])).toMatchObject({ kind: 'missing' });
		expect(locateTodayItem(A, ['- [ ] Write intro 📅 2026-11-20', '- [ ] Write intro 📅 2026-11-21'])).toMatchObject({ kind: 'missing' });
		expect(locateTodayItem(A, ['- [ ] Write the intro'])).toMatchObject({ kind: 'missing' });
	});
});

describe('splitting a block between tasks', () => {
	it('measures focus time from the time left', () => {
		expect(focusElapsedMs(25, 25 * 60_000)).toBe(0);
		expect(focusElapsedMs(25, 15 * 60_000)).toBe(10 * 60_000);
		expect(focusElapsedMs(25, 0)).toBe(25 * 60_000);
	});

	it('gives each finished task its part and the rest to the task current at the end', () => {
		// 25 minute block: A ticked at 10:20 in, B ticked at 17:00 in, C current at the end.
		const a = takeSegment(10 * 60_000 + 20_000, 0);
		expect(a.minutes).toBe(10);
		const b = takeSegment(17 * 60_000, a.nextStartMs);
		expect(b.minutes).toBe(7);
		expect(remainingMinutes(25, [a.minutes, b.minutes])).toBe(8);
	});

	it('never gives out negative or extra minutes', () => {
		expect(takeSegment(5_000, 10_000)).toEqual({ minutes: 0, nextStartMs: 10_000 });
		expect(remainingMinutes(25, [20, 10])).toBe(0);
	});
});

describe('switching the current task during a block', () => {
	const a = item('A');
	const b = item('B');
	const c = item('C');

	it('gives the outgoing task its part without marking it finished, and the rest goes on', () => {
		// 25 minute block: switched from A to B at 10:00 in, B ticked at 18:00 in, C current at the end.
		const first = closePart(NO_SPLIT, 10 * 60_000, a, false);
		expect(first.minutes).toBe(10);
		expect(first.split).toEqual({ startMs: 10 * 60_000, given: [10], finished: [] });
		const second = closePart(first.split, 18 * 60_000, b, true);
		expect(second.minutes).toBe(8);
		expect(second.split.finished).toEqual([b]);
		expect(remainingMinutes(25, second.split.given)).toBe(7);
		// The input split is never changed.
		expect(NO_SPLIT).toEqual({ startMs: 0, given: [], finished: [] });
	});

	it('a quick double switch gives 0 minutes to the task held for a few seconds', () => {
		const first = closePart(NO_SPLIT, 10 * 60_000, a, false);
		const back = closePart(first.split, 10 * 60_000 + 10_000, b, false);
		expect(back.minutes).toBe(0);
		expect(back.split.given).toEqual([10, 0]);
		// Those seconds stay with the rest of the block: A, current again, gets 15 at the end.
		expect(remainingMinutes(25, back.split.given)).toBe(15);
	});

	it('"Next task" sends the current task to the end and the second becomes current', () => {
		expect(texts(currentToEnd([a, b, c]))).toEqual(['B', 'C', 'A']);
		expect(texts(currentToEnd([a, b]))).toEqual(['B', 'A']);
		expect(texts(currentToEnd([a]))).toEqual(['A']);
		expect(currentToEnd([])).toEqual([]);
	});

	it('knows when the current task changed', () => {
		expect(currentChanged(a, b)).toBe(true);
		expect(currentChanged(a, null)).toBe(true);
		expect(currentChanged(a, { ...a })).toBe(false);
		expect(currentChanged(null, a)).toBe(false);
		expect(currentChanged(null, null)).toBe(false);
	});
});

describe('Today items among identical lines (review 2, note safety S2)', () => {
	const R = { path: 'P.md', line: 3, raw: '- [ ] Review', text: 'Review', noteName: 'P', copy: 1, copies: 2 };

	it('follows the copy, not the nearest line', () => {
		const lines = ['- [ ] Review', 'a', 'b', 'c', 'd', '- [ ] Review'];
		expect(locateTodayItem(R, lines)).toEqual({ kind: 'same', line: 5, copy: { copy: 1, copies: 2 } });
	});

	it('reports missing when the copies cannot be told apart', () => {
		expect(locateTodayItem({ ...R, copy: undefined, copies: undefined }, ['- [ ] Review', '- [ ] Review'])).toEqual({ kind: 'missing' });
		expect(locateTodayItem(R, ['- [ ] Review', '- [ ] Review', '- [ ] Review'])).toEqual({ kind: 'missing' });
	});

	it('keeps the copy fields only while there is more than one copy, and saves them', () => {
		expect(atPlace(R, 0, { copy: 0, copies: 1 })).toEqual({ path: 'P.md', line: 0, raw: '- [ ] Review', text: 'Review', noteName: 'P' });
		expect(samePlace(R, 3, { copy: 1, copies: 2 })).toBe(true);
		expect(samePlace(R, 3, { copy: 0, copies: 2 })).toBe(false);
		const saved = parseTodayState({ day: '2026-11-16', items: [R, { ...R, raw: '- [ ] X', copy: 5, copies: 2 }] }, '2026-11-16');
		expect(saved.items[0]).toMatchObject({ copy: 1, copies: 2 });
		expect(saved.items[1]?.copy).toBeUndefined();
	});
});
