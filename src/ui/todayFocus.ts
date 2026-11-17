/**
 * Where keyboard focus goes in the Today list after it is rebuilt. Pure, so it
 * can be tested without a DOM; the view applies the result.
 */

/** 'pick' is a row's task text (makes it current); 'next' is "Next task" on the current row. */
export type TodayControl = 'done' | 'pick' | 'next' | 'up' | 'down' | 'remove';

export interface TodayFocus {
	index: number;
	control: TodayControl;
}

/** Where focus goes when the wanted control is disabled (e.g. "Move up" on the first row). */
const FALLBACK: Record<TodayControl, readonly TodayControl[]> = {
	done: ['remove'],
	pick: ['done'],
	next: ['pick'],
	up: ['down', 'done'],
	down: ['up', 'done'],
	remove: ['done'],
};

export function isTodayControl(value: string | undefined): value is TodayControl {
	return value === 'done' || value === 'pick' || value === 'next' || value === 'up' || value === 'down' || value === 'remove';
}

/**
 * The control to focus in a list of `count` rows: the same control on the row
 * now at `focus.index` (after a removal or tick that is the next task, or the
 * previous one when the last task left), falling back to another control on
 * that row when it is disabled. 'heading' when the list is empty.
 */
export function focusTarget(
	focus: TodayFocus,
	count: number,
	isDisabled: (index: number, control: TodayControl) => boolean,
): TodayFocus | 'heading' | null {
	if (count === 0) return 'heading';
	const index = Math.max(0, Math.min(count - 1, focus.index));
	for (const control of [focus.control, ...FALLBACK[focus.control]]) {
		if (!isDisabled(index, control)) return { index, control };
	}
	return null;
}

/**
 * Disabled controls of a row: "Move up" on the first row, "Move down" on the
 * last, and "Next task", which only the first row has, with a second task to go to.
 */
export function isDisabledControl(index: number, count: number, control: TodayControl): boolean {
	return (control === 'up' && index === 0) || (control === 'down' && index === count - 1) || (control === 'next' && (index !== 0 || count < 2));
}
