import { describe, expect, it } from 'vitest';
import { formatLogLine } from '../src/logic/logLine';
import {
	addDays,
	computeStats,
	entriesFromNote,
	type FocusEntry,
	linkName,
	minutesByNote,
	parseLogLine,
	weekStart,
} from '../src/logic/stats';

describe('parseLogLine', () => {
	it('reads the lines Kiri writes', () => {
		const line = formatLogLine({
			start: new Date(2026, 10, 15, 10, 0),
			end: new Date(2026, 10, 15, 10, 25),
			label: 'Focus',
			link: '[[Website relaunch]]',
			task: 'Write the about page',
		});
		expect(parseLogLine(line)).toEqual({
			date: null,
			minutes: 25,
			label: 'Focus',
			note: 'Website relaunch',
			task: 'Write the about page',
		});
	});

	it('reads lines with a date, without a task and with Markdown links', () => {
		expect(parseLogLine('- 2026-11-15 09:00–09:50 · Focus')).toMatchObject({ date: '2026-11-15', minutes: 50, note: null, task: null });
		expect(parseLogLine('- 09:00–09:25 · Focus · [Plan](Projects/Plan.md) · A · B')).toMatchObject({ note: 'Plan', task: 'A · B' });
		expect(parseLogLine('- 09:00–09:25 · Focus · just a task')).toMatchObject({ note: null, task: 'just a task' });
	});

	it('counts the focus minutes of a paused block, not the clock span', () => {
		const line = formatLogLine({
			start: new Date(2026, 10, 15, 10, 0),
			end: new Date(2026, 10, 15, 11, 5),
			label: 'Focus',
			task: 'Write',
			minutes: 25,
		});
		expect(line).toBe('- 10:00–11:05 · Focus (25m) · Write');
		expect(parseLogLine(line)).toMatchObject({ minutes: 25, label: 'Focus', task: 'Write' });
		expect(entriesFromNote(line, '2026-11-15')).toEqual([{ date: '2026-11-15', minutes: 25, note: null }]);
	});

	it('handles blocks past midnight and caps very long ones', () => {
		expect(parseLogLine('- 23:50–00:15 · Focus')?.minutes).toBe(25);
		expect(parseLogLine('- 08:00–13:00 · Focus')?.minutes).toBe(120);
	});

	it('ignores other lines', () => {
		expect(parseLogLine('- [ ] 10:00–10:25 · Focus')).toBeNull();
		expect(parseLogLine('Some text 10:00–10:25')).toBeNull();
		expect(parseLogLine('## Focus log')).toBeNull();
	});

	it('names links by their note', () => {
		expect(linkName('[[Folder/Plan|Alias]]')).toBe('Plan');
		expect(linkName('[[Plan#Heading]]')).toBe('Plan');
		expect(linkName('[My plan](My%20plan.md)')).toBe('My plan');
	});
});

describe('entriesFromNote', () => {
	it('takes only Focus lines and uses the note date unless the line has one', () => {
		const note = '# Day\n## Focus log\n- 09:00–09:25 · Focus · [[A]]\n- 10:00–10:05 · Break\n- 2026-11-01 11:00–11:50 · Focus\n';
		expect(entriesFromNote(note, '2026-11-15')).toEqual([
			{ date: '2026-11-15', minutes: 25, note: 'A' },
			{ date: '2026-11-01', minutes: 50, note: null },
		]);
	});

	it('skips undated lines in the fallback note', () => {
		expect(entriesFromNote('- 09:00–09:25 · Focus', null)).toEqual([]);
	});
});

describe('dates', () => {
	it('adds days across months and years', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('finds the Monday of a week', () => {
		expect(weekStart('2026-11-15')).toBe('2026-11-09'); // Sunday
		expect(weekStart('2026-11-16')).toBe('2026-11-16'); // Monday
		expect(weekStart('2026-11-18')).toBe('2026-11-16');
	});
});

describe('computeStats', () => {
	const e = (date: string, minutes = 25, note: string | null = null): FocusEntry => ({ date, minutes, note });
	const today = '2026-11-18'; // Wednesday

	it('totals today and this week', () => {
		const stats = computeStats([e('2026-11-18'), e('2026-11-18', 50), e('2026-11-16'), e('2026-11-15', 90)], today);
		expect(stats.today).toEqual({ blocks: 2, minutes: 75 });
		expect(stats.week).toEqual({ blocks: 3, minutes: 100 });
	});

	it('counts the streak of days with a block', () => {
		expect(computeStats([e('2026-11-18'), e('2026-11-17'), e('2026-11-16'), e('2026-11-14')], today).streak).toBe(3);
	});

	it('keeps yesterday’s streak alive before the first block of today', () => {
		expect(computeStats([e('2026-11-17'), e('2026-11-16')], today).streak).toBe(2);
		expect(computeStats([e('2026-11-16')], today).streak).toBe(0);
		expect(computeStats([], today).streak).toBe(0);
	});

	it('adds up minutes per note in a range', () => {
		const entries = [e('2026-11-18', 25, 'A'), e('2026-11-17', 50, 'B'), e('2026-11-17', 25, 'A'), e('2026-11-18', 25), e('2026-10-01', 90, 'C')];
		expect(minutesByNote(entries, 'week', today)).toEqual([
			{ name: 'A', minutes: 50, blocks: 2 },
			{ name: 'B', minutes: 50, blocks: 1 },
			{ name: null, minutes: 25, blocks: 1 },
		]);
		expect(minutesByNote(entries, 'all', today)[0]).toEqual({ name: 'C', minutes: 90, blocks: 1 });
		expect(minutesByNote(entries, 'month', today).some((r) => r.name === 'C')).toBe(false);
	});
});
