import { describe, expect, it } from 'vitest';
import { blockInCycle, CYCLE_RESET_MS, type CycleSettings, type CycleState, EMPTY_CYCLE, planBreak, regularBreakMinutes, updatePendingBreak } from '../src/logic/cycle';

const settings: CycleSettings = {
	breaks: { short: 5, medium: 10, long: 15 },
	breakMinutes: null,
	longBreakEnabled: true,
	longBreakMinutes: 15,
	longBreakEvery: 4,
};

function run(blocks: number, s: CycleSettings = settings, gap = 30 * 60_000): { minutes: number[]; cycle: CycleState } {
	let cycle = EMPTY_CYCLE;
	const minutes: number[] = [];
	let now = 1_000_000;
	for (let i = 0; i < blocks; i++) {
		now += gap;
		const plan = planBreak(cycle, 25, s, now);
		minutes.push(plan.minutes);
		cycle = plan.cycle;
	}
	return { minutes, cycle };
}

describe('pomodoro cycle', () => {
	it('gives a long break after every 4th block', () => {
		expect(run(8).minutes).toEqual([5, 5, 5, 15, 5, 5, 5, 15]);
	});

	it('follows the "every N" setting', () => {
		expect(run(4, { ...settings, longBreakEvery: 2, longBreakMinutes: 20 }).minutes).toEqual([5, 20, 5, 20]);
	});

	it('uses normal breaks when long breaks are off', () => {
		expect(run(4, { ...settings, longBreakEnabled: false }).minutes).toEqual([5, 5, 5, 5]);
	});

	it('never makes the long break shorter than the normal one', () => {
		const plan = planBreak({ completed: 3, lastFocusEnd: 0 }, 90, settings, 1000);
		expect(plan).toMatchObject({ minutes: 15, isLong: true });
		const short = planBreak({ completed: 3, lastFocusEnd: 0 }, 90, { ...settings, longBreakMinutes: 8 }, 1000);
		expect(short.minutes).toBe(15);
	});

	it('starts a new cycle after a long gap', () => {
		const cycle = { completed: 3, lastFocusEnd: 0 };
		const plan = planBreak(cycle, 25, settings, CYCLE_RESET_MS + 1);
		expect(plan).toMatchObject({ minutes: 5, isLong: false, cycle: { completed: 1 } });
	});

	it('says which block of the cycle is next', () => {
		expect(blockInCycle(EMPTY_CYCLE, 4, 0)).toBe(1);
		expect(blockInCycle({ completed: 2, lastFocusEnd: 100 }, 4, 200)).toBe(3);
		expect(blockInCycle({ completed: 4, lastFocusEnd: 100 }, 4, 200)).toBe(1);
		expect(blockInCycle({ completed: 2, lastFocusEnd: 0 }, 4, CYCLE_RESET_MS + 1)).toBe(1);
	});
});

describe('chosen break length', () => {
	it('Auto picks the break by block length', () => {
		expect(regularBreakMinutes(25, settings)).toBe(5);
		expect(regularBreakMinutes(50, settings)).toBe(10);
		expect(regularBreakMinutes(52, settings)).toBe(15);
		expect(regularBreakMinutes(90, settings)).toBe(15);
	});

	it('a set length applies after every block, whatever its length', () => {
		const s = { ...settings, breakMinutes: 17 };
		for (const block of [5, 25, 50, 52, 90, 120]) expect(regularBreakMinutes(block, s)).toBe(17);
		expect(planBreak(EMPTY_CYCLE, 90, { ...settings, breakMinutes: 5 }, 1000)).toMatchObject({ minutes: 5, isLong: false });
	});

	it('the long break still comes every N blocks and is never shorter than the set break', () => {
		expect(run(4, { ...settings, breakMinutes: 10 }).minutes).toEqual([10, 10, 10, 15]);
		expect(run(4, { ...settings, breakMinutes: 20 }).minutes).toEqual([20, 20, 20, 20]);
		expect(run(4, { ...settings, breakMinutes: 3, longBreakEnabled: false }).minutes).toEqual([3, 3, 3, 3]);
	});

	it('a waiting regular break takes the new length; a long one keeps its own', () => {
		const pending = { minutes: 10, isLong: false, blockMinutes: 50 };
		expect(updatePendingBreak(pending, { ...settings, breakMinutes: 17 }, 25)).toEqual({ ...pending, minutes: 17 });
		// Back to Auto: by the length of the block the break follows, not the length now set.
		expect(updatePendingBreak({ ...pending, minutes: 17 }, settings, 25)).toEqual(pending);
		const long = { minutes: 15, isLong: true, blockMinutes: 25 };
		expect(updatePendingBreak(long, { ...settings, breakMinutes: 5 }, 25)).toBe(long);
		expect(updatePendingBreak(null, { ...settings, breakMinutes: 5 }, 25)).toBeNull();
	});

	it('a waiting break saved without its block length uses the fallback', () => {
		expect(updatePendingBreak({ minutes: 17, isLong: false }, settings, 50)).toEqual({ minutes: 10, isLong: false });
	});
});
