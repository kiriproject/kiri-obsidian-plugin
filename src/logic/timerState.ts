import { minutesToMs } from './duration';

export type Phase = 'idle' | 'focus' | 'break';

/**
 * Timer state. All times are epoch milliseconds, so the countdown stays
 * correct even when the app throttles intervals in the background.
 */
export interface TimerState {
	phase: Phase;
	running: boolean;
	/** Planned length of the current block in minutes. */
	minutes: number;
	/** When the block ends; only meaningful while running. */
	endAt: number;
	/** Time left when paused. */
	remainingMs: number;
	/** When the block was first started (for the log line). */
	startedAt: number;
}

export function idleState(minutes: number): TimerState {
	return { phase: 'idle', running: false, minutes, endAt: 0, remainingMs: minutesToMs(minutes), startedAt: 0 };
}

export function startBlock(phase: 'focus' | 'break', minutes: number, now: number): TimerState {
	const length = minutesToMs(minutes);
	return { phase, running: true, minutes, endAt: now + length, remainingMs: length, startedAt: now };
}

export function pause(state: TimerState, now: number): TimerState {
	if (!state.running || state.phase === 'idle') return state;
	return { ...state, running: false, remainingMs: Math.max(0, state.endAt - now) };
}

export function resume(state: TimerState, now: number): TimerState {
	if (state.running || state.phase === 'idle') return state;
	return { ...state, running: true, endAt: now + state.remainingMs };
}

export function remainingMs(state: TimerState, now: number): number {
	if (state.phase === 'idle') return minutesToMs(state.minutes);
	if (!state.running) return state.remainingMs;
	return Math.max(0, state.endAt - now);
}

export function isFinished(state: TimerState, now: number): boolean {
	return state.phase !== 'idle' && state.running && now >= state.endAt;
}
