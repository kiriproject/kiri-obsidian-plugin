import { describe, expect, it } from 'vitest';
import {
	addSpent,
	formatDurationText,
	hasUnreadableCounter,
	hasUnreadableSpent,
	incrementCounter,
	metadataStart,
	parseDurationText,
	plainTaskText,
	readPlanned,
	readSpent,
	setInlineField,
	setSpent,
} from '../src/logic/taskLine';

describe('durations', () => {
	it('reads common ways of writing a duration', () => {
		expect(parseDurationText('90')).toBe(90);
		expect(parseDurationText('90m')).toBe(90);
		expect(parseDurationText('90 min')).toBe(90);
		expect(parseDurationText('1h')).toBe(60);
		expect(parseDurationText('1.5h')).toBe(90);
		expect(parseDurationText('1h 30m')).toBe(90);
		expect(parseDurationText('2 hours')).toBe(120);
		expect(parseDurationText('1 hour, 5 minutes')).toBe(65);
	});

	it('rejects text that is not a duration', () => {
		expect(parseDurationText('')).toBeNull();
		expect(parseDurationText('soon')).toBeNull();
		expect(parseDurationText('2h and a bit')).toBeNull();
	});

	it('formats minutes so they read back the same', () => {
		expect(formatDurationText(0)).toBe('0m');
		expect(formatDurationText(45)).toBe('45m');
		expect(formatDurationText(60)).toBe('1h');
		expect(formatDurationText(75)).toBe('1h 15m');
		for (const n of [5, 25, 60, 99, 125, 600]) expect(parseDurationText(formatDurationText(n))).toBe(n);
	});
});

describe('spent time on the task line', () => {
	it('adds a spent field to a plain task', () => {
		expect(addSpent('- [ ] Write intro', 25)).toBe('- [ ] Write intro [spent:: 25m]');
	});

	it('adds up blocks in place', () => {
		const once = addSpent('- [ ] Write intro', 25)!;
		const twice = addSpent(once, 50)!;
		expect(twice).toBe('- [ ] Write intro [spent:: 1h 15m]');
		expect(readSpent(twice)).toBe(75);
	});

	it('is idempotent when setting the same total', () => {
		const line = '- [ ] Draft intro [kiri:: 1] 📅 2026-11-20';
		const a = setSpent(line, 25)!;
		expect(setSpent(a, 25)).toBe(a);
	});

	it('keeps Tasks plugin emoji fields at the end of the line', () => {
		expect(addSpent('- [ ] Review copy ⏫ 📅 2026-11-22', 25)).toBe('- [ ] Review copy [spent:: 25m] ⏫ 📅 2026-11-22');
		expect(addSpent('- [ ] Weekly check 🔁 every week 📅 2026-11-17', 50)).toBe(
			'- [ ] Weekly check [spent:: 50m] 🔁 every week 📅 2026-11-17',
		);
	});

	it('keeps Tasks plugin Dataview-format fields at the end of the line', () => {
		expect(addSpent('- [ ] Draft intro [due:: 2026-11-20] [priority:: high]', 25)).toBe(
			'- [ ] Draft intro [spent:: 25m] [due:: 2026-11-20] [priority:: high]',
		);
		expect(addSpent('- [ ] Draft intro (due:: 2026-11-20)', 25)).toBe('- [ ] Draft intro [spent:: 25m] (due:: 2026-11-20)');
	});

	it('works next to the block counter and a block id', () => {
		const counted = incrementCounter('- [ ] Prepare launch email #email ^launch-mail')!;
		const spent = addSpent(counted, 25)!;
		expect(spent).toBe('- [ ] Prepare launch email #email [kiri:: 1] [spent:: 25m] ^launch-mail');
		expect(incrementCounter(spent)).toBe('- [ ] Prepare launch email #email [kiri:: 2] [spent:: 25m] ^launch-mail');
	});

	it('reads planned or estimate fields', () => {
		expect(readPlanned('- [ ] Write [planned:: 2h]')).toBe(120);
		expect(readPlanned('- [ ] Write [estimate:: 50m]')).toBe(50);
		expect(readPlanned('- [ ] Write')).toBeNull();
	});

	it('leaves Kiri fields out of the log text', () => {
		expect(plainTaskText('Write [planned:: 2h] [kiri:: 2] [spent:: 50m] 📅 2026-11-20')).toBe('Write');
	});

	it('leaves a spent value it cannot read alone', () => {
		expect(addSpent('- [ ] Write [spent:: 1:30]', 25)).toBeNull();
		expect(addSpent('- [ ] Write [spent:: ~2h]', 25)).toBeNull();
		expect(hasUnreadableSpent('- [ ] Write [spent:: 1:30]')).toBe(true);
		expect(hasUnreadableSpent('- [ ] Write [spent:: 1h 30m]')).toBe(false);
		expect(hasUnreadableSpent('- [ ] Write')).toBe(false);
	});

	it('leaves a block counter it cannot read alone', () => {
		expect(incrementCounter('- [ ] Write [kiri:: lots]')).toBeNull();
		expect(hasUnreadableCounter('- [ ] Write [kiri:: lots]')).toBe(true);
		expect(hasUnreadableCounter('- [ ] Write [kiri:: 3]')).toBe(false);
		expect(hasUnreadableCounter('- [ ] Write')).toBe(false);
	});

	it('returns null for lines that are not tasks', () => {
		expect(addSpent('- plain bullet', 25)).toBeNull();
		expect(setInlineField('text', 'spent', '1m')).toBeNull();
	});

	it('reads Tasks fields from the end, not at the first emoji', () => {
		const line = '- [ ] Review ✅ checklist with Ana 📅 2026-11-20';
		expect(incrementCounter(line)).toBe('- [ ] Review ✅ checklist with Ana [kiri:: 1] 📅 2026-11-20');
		expect(plainTaskText('Review ✅ checklist with Ana 📅 2026-11-20')).toBe('Review ✅ checklist with Ana');
		expect(plainTaskText('Ship it 🔁 every week ⏫ #work 📅 2026-11-20')).toBe('Ship it');
		expect(plainTaskText('Ship it 📅 2026-11-20 #work')).toBe('Ship it');
		expect(plainTaskText('Plan 📅 sometime')).toBe('Plan 📅 sometime');
	});

	it('finds where Tasks fields start', () => {
		expect(metadataStart('Write [due:: 2026-11-20]')).toBe(6);
		expect(metadataStart('Write #work')).toBe('Write #work'.length);
		expect(metadataStart('Write [kiri:: 2]')).toBe('Write [kiri:: 2]'.length);
	});
});
