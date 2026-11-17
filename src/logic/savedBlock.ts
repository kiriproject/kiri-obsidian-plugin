/**
 * The running block, saved on this device so that closing Obsidian, a plugin
 * update or a reload does not lose it. Pure functions only.
 */
import type { CycleState, PendingBreak } from './cycle';
import type { TimerState } from './timerState';
import { type BlockSplit, parseTodayState, type TodayItem } from './today';

export interface SavedBlock {
	timer: TimerState;
	/** Parts of the block already given to tasks ticked done or switched away from during it. */
	split: BlockSplit;
	cycle: CycleState;
	longBreak: boolean;
	pendingBreak: PendingBreak | null;
	/** Blocks started by themselves in a row (see MAX_AUTO_BLOCKS). */
	autoBlocks: number;
	/** The single picked task (Today itself is in data.json). */
	picked: TodayItem | null;
	hint: string;
}

/** Key of the saved block in the device storage. */
export const BLOCK_KEY = 'kiri-focus-timer-block';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function items(value: unknown): TodayItem[] {
	return Array.isArray(value) ? parseTodayState({ day: '2000-01-01', items: value }, '2000-01-01').items : [];
}

/** Read a saved block, or null when there is none or it is damaged. */
export function parseSavedBlock(value: unknown): SavedBlock | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	const t = v.timer as Partial<Record<keyof TimerState, unknown>> | undefined;
	if (!t || typeof t !== 'object') return null;
	if (t.phase !== 'focus' && t.phase !== 'break' && t.phase !== 'idle') return null;
	if (typeof t.running !== 'boolean' || !num(t.minutes) || !num(t.endAt) || !num(t.remainingMs) || !num(t.startedAt)) return null;
	if (t.minutes < 1 || t.minutes > 120 || t.remainingMs < 0 || t.remainingMs > t.minutes * 60_000) return null;
	const timer: TimerState = { phase: t.phase, running: t.running, minutes: t.minutes, endAt: t.endAt, remainingMs: t.remainingMs, startedAt: t.startedAt };

	const s = (v.split && typeof v.split === 'object' ? v.split : {}) as Record<string, unknown>;
	const given = Array.isArray(s.given) ? s.given.filter((g): g is number => num(g) && g >= 0) : [];
	const split = { startMs: num(s.startMs) && s.startMs >= 0 ? s.startMs : 0, given, finished: items(s.finished) };

	const c = (v.cycle && typeof v.cycle === 'object' ? v.cycle : {}) as Record<string, unknown>;
	const cycle: CycleState = { completed: num(c.completed) && c.completed >= 0 ? Math.round(c.completed) : 0, lastFocusEnd: num(c.lastFocusEnd) ? c.lastFocusEnd : 0 };

	const p = v.pendingBreak as Record<string, unknown> | null | undefined;
	let pendingBreak: PendingBreak | null = null;
	if (p && typeof p === 'object' && num(p.minutes) && p.minutes >= 1 && p.minutes <= 60) {
		pendingBreak = { minutes: p.minutes, isLong: p.isLong === true };
		if (num(p.blockMinutes) && p.blockMinutes >= 1 && p.blockMinutes <= 120) pendingBreak.blockMinutes = p.blockMinutes;
	}

	return {
		timer,
		split,
		cycle,
		longBreak: v.longBreak === true,
		pendingBreak,
		autoBlocks: num(v.autoBlocks) && v.autoBlocks >= 0 ? Math.round(v.autoBlocks) : 0,
		picked: items(v.picked ? [v.picked] : [])[0] ?? null,
		hint: typeof v.hint === 'string' ? v.hint.slice(0, 200) : '',
	};
}
