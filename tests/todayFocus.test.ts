import { describe, expect, it } from 'vitest';
import { controlsLayout, taskListSignature } from '../src/ui/viewSignature';
import { focusTarget, isDisabledControl, isTodayControl, type TodayControl } from '../src/ui/todayFocus';

const disabled = (count: number) => (index: number, control: TodayControl) => isDisabledControl(index, count, control);

describe('keyboard focus after the Today list is rebuilt (review S6)', () => {
	it('after removing or ticking, focuses the same control on the next task', () => {
		// Removed the 2nd of 4: three left, the row at index 1 is the next task.
		expect(focusTarget({ index: 1, control: 'remove' }, 3, disabled(3))).toEqual({ index: 1, control: 'remove' });
		expect(focusTarget({ index: 1, control: 'done' }, 3, disabled(3))).toEqual({ index: 1, control: 'done' });
	});

	it('after the last row left, focuses the row before it', () => {
		expect(focusTarget({ index: 3, control: 'remove' }, 3, disabled(3))).toEqual({ index: 2, control: 'remove' });
	});

	it('focuses the heading when the list is empty', () => {
		expect(focusTarget({ index: 0, control: 'done' }, 0, disabled(0))).toBe('heading');
	});

	it('after a move, falls back to the other arrow at the top or bottom', () => {
		expect(focusTarget({ index: 0, control: 'up' }, 3, disabled(3))).toEqual({ index: 0, control: 'down' });
		expect(focusTarget({ index: 2, control: 'down' }, 3, disabled(3))).toEqual({ index: 2, control: 'up' });
		expect(focusTarget({ index: 1, control: 'up' }, 3, disabled(3))).toEqual({ index: 1, control: 'up' });
		// One row: both arrows are off, so the checkbox.
		expect(focusTarget({ index: 0, control: 'down' }, 1, disabled(1))).toEqual({ index: 0, control: 'done' });
	});

	it('after picking a row or "Next task", focus stays on the current row', () => {
		expect(focusTarget({ index: 0, control: 'pick' }, 3, disabled(3))).toEqual({ index: 0, control: 'pick' });
		expect(focusTarget({ index: 0, control: 'next' }, 3, disabled(3))).toEqual({ index: 0, control: 'next' });
		// "Next task" is off with one task left, and only the first row has it.
		expect(focusTarget({ index: 0, control: 'next' }, 1, disabled(1))).toEqual({ index: 0, control: 'pick' });
		expect(isDisabledControl(1, 3, 'next')).toBe(true);
		expect(isTodayControl('pick')).toBe(true);
		expect(isTodayControl('next')).toBe(true);
	});

	it('reads control names from the DOM safely', () => {
		expect(isTodayControl('remove')).toBe(true);
		expect(isTodayControl('nope')).toBe(false);
		expect(isTodayControl(undefined)).toBe(false);
	});
});

describe('view parts redraw only when they change (review 2, code S5)', () => {
	it('pausing or resuming keeps the same timer buttons', () => {
		expect(controlsLayout('focus', null)).toBe(controlsLayout('focus', null));
		expect(controlsLayout('idle', null)).not.toBe(controlsLayout('focus', null));
		expect(controlsLayout('idle', { isLong: false })).not.toBe(controlsLayout('idle', { isLong: true }));
		expect(controlsLayout('break', null)).not.toBe(controlsLayout('focus', null));
	});

	it('the task list signature changes with what it shows, and only then', () => {
		const base = { allNotes: false, capped: false, total: 2, activeFile: 'A.md', selected: null, shown: [{ path: 'A.md', raw: '- [ ] x', onToday: false }] };
		expect(taskListSignature(base)).toBe(taskListSignature({ ...base, shown: [...base.shown] }));
		expect(taskListSignature({ ...base, selected: { path: 'A.md', raw: '- [ ] x' } })).not.toBe(taskListSignature(base));
		expect(taskListSignature({ ...base, shown: [{ path: 'A.md', raw: '- [ ] x', onToday: true }] })).not.toBe(taskListSignature(base));
	});
});
