import { describe, expect, it } from 'vitest';
import { parseSavedBlock } from '../src/logic/savedBlock';
import { breakMinutesFor, clampMinutes, formatClock, formatCountdown, readNumberField } from '../src/logic/duration';
import { formatLogLine } from '../src/logic/logLine';
import { applyDailyTemplate } from '../src/logic/template';
import { idleState, isFinished, pause, remainingMs, resume, startBlock } from '../src/logic/timerState';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings';

describe('duration', () => {
	it('clamps custom minutes to 5–120', () => {
		expect(clampMinutes('3')).toBe(5);
		expect(clampMinutes('500')).toBe(120);
		expect(clampMinutes(' 42 ')).toBe(42);
		expect(clampMinutes('37.6')).toBe(38);
		expect(clampMinutes('abc')).toBeNull();
		expect(clampMinutes('')).toBeNull();
	});

	it('picks the break for each block length', () => {
		const b = DEFAULT_SETTINGS.breaks;
		expect(breakMinutesFor(25, b)).toBe(5);
		expect(breakMinutesFor(50, b)).toBe(10);
		expect(breakMinutesFor(90, b)).toBe(15);
		expect(breakMinutesFor(10, b)).toBe(5);
		expect(breakMinutesFor(40, b)).toBe(10);
		expect(breakMinutesFor(120, b)).toBe(15);
	});

	it('formats the countdown', () => {
		expect(formatCountdown(25 * 60_000)).toBe('25:00');
		expect(formatCountdown(90 * 60_000)).toBe('90:00');
		expect(formatCountdown(61_001)).toBe('01:02');
		expect(formatCountdown(-5)).toBe('00:00');
	});

	it('formats clock times', () => {
		expect(formatClock(new Date(2026, 10, 14, 9, 5))).toBe('09:05');
	});
});

describe('timer state', () => {
	it('counts down from the start time', () => {
		const s = startBlock('focus', 25, 1_000);
		expect(remainingMs(s, 1_000)).toBe(25 * 60_000);
		expect(remainingMs(s, 61_000)).toBe(24 * 60_000);
		expect(isFinished(s, 1_000 + 25 * 60_000)).toBe(true);
	});

	it('pauses and resumes without losing time', () => {
		let s = startBlock('focus', 25, 0);
		s = pause(s, 60_000);
		expect(remainingMs(s, 999_999)).toBe(24 * 60_000);
		expect(isFinished(s, 10 ** 9)).toBe(false);
		s = resume(s, 500_000);
		expect(remainingMs(s, 500_000)).toBe(24 * 60_000);
		expect(s.startedAt).toBe(0);
	});

	it('idle shows the chosen length and never finishes', () => {
		const s = idleState(50);
		expect(remainingMs(s, 123)).toBe(50 * 60_000);
		expect(isFinished(s, 10 ** 12)).toBe(false);
		expect(pause(s, 5)).toBe(s);
	});
});

describe('formatLogLine', () => {
	const start = new Date(2026, 10, 14, 10, 0);
	const end = new Date(2026, 10, 14, 10, 25);

	it('writes the full line', () => {
		expect(formatLogLine({ start, end, label: 'Focus', link: '[[Note name]]', task: 'task text' })).toBe(
			'- 10:00–10:25 · Focus · [[Note name]] · task text',
		);
	});

	it('leaves out missing parts', () => {
		expect(formatLogLine({ start, end, label: 'Focus' })).toBe('- 10:00–10:25 · Focus');
		expect(formatLogLine({ start, end, label: 'Focus', task: '  ' })).toBe('- 10:00–10:25 · Focus');
	});
});

describe('applyDailyTemplate', () => {
	const fmt = (p: string): string => `<${p}>`;
	it('fills title, date and time placeholders', () => {
		expect(applyDailyTemplate('# {{title}}\n{{date}} {{time}} {{date:dddd}} {{ time : HH }}', '2026-11-14', 'YYYY-MM-DD', fmt)).toBe(
			'# 2026-11-14\n<YYYY-MM-DD> <HH:mm> <dddd> <HH>',
		);
	});
});

describe('mergeSettings', () => {
	it('returns defaults for empty data', () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it('keeps valid values and drops bad ones', () => {
		const s = mergeSettings({ focusMinutes: 500, sound: 'loud', volume: 30, breaks: { short: 7 }, chime: 'yes' });
		expect(s.focusMinutes).toBe(120);
		expect(s.sound).toBe('off');
		expect(s.volume).toBe(30);
		expect(s.breaks).toEqual({ short: 7, medium: 10, long: 15 });
		expect(s.chime).toBe(true);
	});

	it('reads the cycle, chime and task settings', () => {
		const s = mergeSettings({ longBreakEvery: 1, longBreakMinutes: 20, autoStartBreak: false, chimeStyle: 'soft', writeSpent: true });
		expect(s.longBreakEvery).toBe(2);
		expect(s.longBreakMinutes).toBe(20);
		expect(s.autoStartBreak).toBe(false);
		expect(s.chimeStyle).toBe('soft');
		expect(s.writeSpent).toBe(true);
		expect(mergeSettings({ chimeStyle: 'gong' }).chimeStyle).toBe('bell');
	});

	it('reads Kiri sounds, binaural and sync settings', () => {
		const s = mergeSettings({ sound: 'kiri:rain', binaural: 'alpha', binauralVolume: 250, syncEnabled: false });
		expect(s.sound).toBe('kiri:rain');
		expect(s.binaural).toBe('alpha');
		expect(s.binauralVolume).toBe(100);
		expect(s.syncEnabled).toBe(false);
		expect(mergeSettings({ sound: 'kiri:../x', binaural: 'wave' })).toMatchObject({ sound: 'off', binaural: 'off' });
		expect(DEFAULT_SETTINGS).toMatchObject({ binaural: 'off', syncEnabled: true });
	});

	it('keeps the old behaviour for existing users', () => {
		const s = mergeSettings({ focusMinutes: 30, sound: 'pink' });
		expect(s.autoStartBreak).toBe(true);
		expect(s.writeSpent).toBe(false);
		expect(s.chimeStyle).toBe('bell');
	});

	it('reads the chosen break length, Auto (null) by default', () => {
		expect(DEFAULT_SETTINGS.breakMinutes).toBeNull();
		expect(mergeSettings({ focusMinutes: 30 }).breakMinutes).toBeNull();
		expect(mergeSettings({ breakMinutes: 17 }).breakMinutes).toBe(17);
		expect(mergeSettings({ breakMinutes: 0 }).breakMinutes).toBe(1);
		expect(mergeSettings({ breakMinutes: 90 }).breakMinutes).toBe(60);
		expect(mergeSettings({ breakMinutes: 7.6 }).breakMinutes).toBe(8);
		expect(mergeSettings({ breakMinutes: null }).breakMinutes).toBeNull();
		expect(mergeSettings({ breakMinutes: '10' }).breakMinutes).toBeNull();
		expect(mergeSettings({ breakMinutes: Number.NaN }).breakMinutes).toBeNull();
	});

	it('does not share the default breaks object', () => {
		const s = mergeSettings({});
		s.breaks.short = 99;
		expect(DEFAULT_SETTINGS.breaks.short).toBe(5);
	});
});

describe('parseSavedBlock', () => {
	const timer = { phase: 'focus', running: true, minutes: 25, endAt: 2_000_000, remainingMs: 1_500_000, startedAt: 500_000 };

	it('reads a saved block and drops anything malformed in it', () => {
		const saved = parseSavedBlock({
			timer,
			split: { startMs: -5, given: [3, 'x'], finished: [{ path: 'A.md', line: 0, raw: '- [x] A', text: 'A', noteName: 'A' }, { bad: true }] },
			cycle: { completed: 2, lastFocusEnd: 1 },
			pendingBreak: { minutes: 500 },
			picked: { path: 'B.md', line: 2, raw: '- [ ] B', text: 'B', noteName: 'B', copy: 1, copies: 2 },
			hint: 7,
		});
		expect(saved?.timer).toEqual(timer);
		expect(saved?.split).toEqual({ startMs: 0, given: [3], finished: [{ path: 'A.md', line: 0, raw: '- [x] A', text: 'A', noteName: 'A' }] });
		expect(saved?.pendingBreak).toBeNull();
		expect(saved?.picked).toMatchObject({ path: 'B.md', copy: 1, copies: 2 });
		expect(saved?.hint).toBe('');
	});

	it('keeps the block length of a waiting break when it is valid', () => {
		const idle = { ...timer, phase: 'idle', running: false };
		expect(parseSavedBlock({ timer: idle, pendingBreak: { minutes: 10, isLong: false, blockMinutes: 50 } })?.pendingBreak).toEqual({ minutes: 10, isLong: false, blockMinutes: 50 });
		expect(parseSavedBlock({ timer: idle, pendingBreak: { minutes: 10, isLong: false, blockMinutes: 'x' } })?.pendingBreak).toEqual({ minutes: 10, isLong: false });
		expect(parseSavedBlock({ timer: idle, pendingBreak: { minutes: 10, blockMinutes: 900 } })?.pendingBreak).toEqual({ minutes: 10, isLong: false });
	});

	it('refuses a timer it cannot trust', () => {
		expect(parseSavedBlock(null)).toBeNull();
		expect(parseSavedBlock({ timer: { ...timer, phase: 'nap' } })).toBeNull();
		expect(parseSavedBlock({ timer: { ...timer, minutes: 500 } })).toBeNull();
		expect(parseSavedBlock({ timer: { ...timer, remainingMs: 99_000_000 } })).toBeNull();
	});
});

describe('readNumberField (review 2, code N5)', () => {
	it('clamps to the range, says so, and keeps the value for unreadable input', () => {
		expect(readNumberField('50', 5, 120, 25)).toEqual({ value: 50, text: '50', message: null });
		expect(readNumberField('1', 5, 120, 25)).toEqual({ value: 5, text: '5', message: 'Set to 5: the range is 5 to 120.' });
		expect(readNumberField('500', 5, 120, 25)).toMatchObject({ value: 120, text: '120' });
		expect(readNumberField('abc', 5, 120, 25)).toEqual({ value: 25, text: '25', message: 'Enter a number from 5 to 120. Kept 25.' });
	});
});
