/**
 * What the Kiri view draws, as comparable strings: a part of the view is
 * rebuilt only when its string changes, so keyboard focus is not lost on
 * every tick or unrelated change. Pure functions, for tests.
 */
import type { Phase } from '../logic/timerState';

/**
 * Which set of timer buttons is shown. Pausing or resuming does not change it
 * (only the Pause/Resume text changes).
 */
export function controlsLayout(phase: Phase, pendingBreak: { isLong: boolean } | null): string {
	if (phase !== 'idle') return phase;
	return pendingBreak ? `pending:${pendingBreak.isLong}` : 'idle';
}

export interface TaskListState {
	allNotes: boolean;
	capped: boolean;
	total: number;
	activeFile: string;
	selected: { path: string; raw: string } | null;
	shown: readonly { path: string; raw: string; onToday: boolean }[];
}

/** Everything the task list shows; equal strings mean nothing to redraw. */
export function taskListSignature(state: TaskListState): string {
	return JSON.stringify([
		state.allNotes,
		state.capped,
		state.total,
		state.activeFile,
		state.selected ? [state.selected.path, state.selected.raw] : null,
		state.shown.map((t) => [t.path, t.raw, t.onToday]),
	]);
}
