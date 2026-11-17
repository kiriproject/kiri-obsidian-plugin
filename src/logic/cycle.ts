import { type BreakLengths, breakMinutesFor } from './duration';

/** A gap this long between blocks starts a new cycle. */
export const CYCLE_RESET_MS = 2 * 60 * 60 * 1000;

export interface CycleSettings {
	breaks: BreakLengths;
	/** The break after every block in minutes, or null for Auto (by block length, see `breaks`). */
	breakMinutes: number | null;
	longBreakEnabled: boolean;
	longBreakMinutes: number;
	/** A long break comes after every this many focus blocks. */
	longBreakEvery: number;
}

/** Focus blocks finished in the current cycle, and when the last one ended (epoch ms). */
export interface CycleState {
	completed: number;
	lastFocusEnd: number;
}

export const EMPTY_CYCLE: CycleState = { completed: 0, lastFocusEnd: 0 };

/** A break that waits for a click. `blockMinutes`: length of the block it follows (missing in blocks saved before 0.3.3). */
export interface PendingBreak {
	minutes: number;
	isLong: boolean;
	blockMinutes?: number;
}

export interface BreakPlan {
	minutes: number;
	isLong: boolean;
	cycle: CycleState;
}

/** Blocks counted so far, forgetting an old cycle after a long gap. */
export function activeCount(cycle: CycleState, now: number): number {
	if (cycle.completed <= 0) return 0;
	return now - cycle.lastFocusEnd > CYCLE_RESET_MS ? 0 : cycle.completed;
}

/**
 * Count a finished focus block and pick the break that follows.
 * Every Nth block gets the long break (never shorter than the normal one).
 */
export function planBreak(cycle: CycleState, focusMinutes: number, settings: CycleSettings, now: number): BreakPlan {
	const completed = activeCount(cycle, now) + 1;
	const every = Math.max(1, Math.round(settings.longBreakEvery));
	const normal = regularBreakMinutes(focusMinutes, settings);
	const isLong = settings.longBreakEnabled && completed % every === 0;
	return {
		minutes: isLong ? Math.max(settings.longBreakMinutes, normal) : normal,
		isLong,
		cycle: { completed, lastFocusEnd: now },
	};
}

/** Which block of the cycle comes next (or is running), 1-based, e.g. 3 of 4. */
export function blockInCycle(cycle: CycleState, every: number, now: number): number {
	const n = Math.max(1, Math.round(every));
	return (activeCount(cycle, now) % n) + 1;
}

/**
 * The regular (not long) break after a block: the chosen length, or with Auto
 * the one that goes with the block length.
 */
export function regularBreakMinutes(focusMinutes: number, settings: Pick<CycleSettings, 'breaks' | 'breakMinutes'>): number {
	return settings.breakMinutes ?? breakMinutesFor(focusMinutes, settings.breaks);
}

/**
 * A waiting break after the break length was changed: a regular break takes
 * the new length; a long break keeps its own. `fallbackBlockMinutes` stands in
 * for a waiting break saved without the length of its block.
 */
export function updatePendingBreak(
	pending: PendingBreak | null,
	settings: Pick<CycleSettings, 'breaks' | 'breakMinutes'>,
	fallbackBlockMinutes: number,
): PendingBreak | null {
	if (!pending || pending.isLong) return pending;
	const minutes = regularBreakMinutes(pending.blockMinutes ?? fallbackBlockMinutes, settings);
	return minutes === pending.minutes ? pending : { ...pending, minutes };
}
