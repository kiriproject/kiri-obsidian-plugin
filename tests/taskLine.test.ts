import { describe, expect, it } from 'vitest';
import {
	incrementCounter,
	isOpenTask,
	copyOf,
	logTaskText,
	locateLine,
	markDonePlain,
	parseTaskLine,
	plainTaskText,
	readCounter,
	replaceLine,
} from '../src/logic/taskLine';

describe('parseTaskLine', () => {
	it('reads plain, indented, numbered and quoted tasks', () => {
		expect(parseTaskLine('- [ ] Write intro')).toEqual({ prefix: '- [', status: ' ', text: 'Write intro' });
		expect(parseTaskLine('    * [x] Done thing')?.status).toBe('x');
		expect(parseTaskLine('1. [ ] Numbered')?.text).toBe('Numbered');
		expect(parseTaskLine('> - [ ] Quoted')?.prefix).toBe('> - [');
		expect(parseTaskLine('+ [/] In progress')?.status).toBe('/');
	});

	it('rejects lines that are not tasks', () => {
		expect(parseTaskLine('- plain bullet')).toBeNull();
		expect(parseTaskLine('[ ] no bullet')).toBeNull();
		expect(parseTaskLine('-[ ] no space')).toBeNull();
		expect(parseTaskLine('Some text - [ ] inside')).toBeNull();
	});

	it('knows open from done', () => {
		expect(isOpenTask('- [ ] open')).toBe(true);
		expect(isOpenTask('- [x] done')).toBe(false);
		expect(isOpenTask('- [-] cancelled')).toBe(false);
	});
});

describe('incrementCounter', () => {
	it('adds a counter to a plain task', () => {
		expect(incrementCounter('- [ ] Write intro')).toBe('- [ ] Write intro [kiri:: 1]');
	});

	it('adds the counter before Tasks plugin emoji fields', () => {
		expect(incrementCounter('- [ ] Draft intro 📅 2026-11-20')).toBe('- [ ] Draft intro [kiri:: 1] 📅 2026-11-20');
		expect(incrementCounter('- [ ] Call back ⏫ 🔁 every week 📅 2026-11-20')).toBe(
			'- [ ] Call back [kiri:: 1] ⏫ 🔁 every week 📅 2026-11-20',
		);
	});

	it('adds the counter before a block id', () => {
		expect(incrementCounter('- [ ] Review ^abc-123')).toBe('- [ ] Review [kiri:: 1] ^abc-123');
	});

	it('increments an existing counter in place', () => {
		expect(incrementCounter('- [ ] Draft intro [kiri:: 1] 📅 2026-11-20')).toBe('- [ ] Draft intro [kiri:: 2] 📅 2026-11-20');
		expect(incrementCounter('  - [ ] Nested [kiri::9]')).toBe('  - [ ] Nested [kiri:: 10]');
	});

	it('keeps indentation and tags', () => {
		expect(incrementCounter('\t- [ ] Read #reading')).toBe('\t- [ ] Read #reading [kiri:: 1]');
	});

	it('returns null for non-task lines', () => {
		expect(incrementCounter('just text')).toBeNull();
	});

	it('reads the counter', () => {
		expect(readCounter('- [ ] a [kiri:: 4]')).toBe(4);
		expect(readCounter('- [ ] a')).toBe(0);
	});
});

describe('markDonePlain', () => {
	it('ticks the box and keeps the rest', () => {
		expect(markDonePlain('  - [ ] Draft intro 📅 2026-11-20')).toBe('  - [x] Draft intro 📅 2026-11-20');
	});
	it('ignores tasks that are not open', () => {
		expect(markDonePlain('- [x] done')).toBeNull();
		expect(markDonePlain('text')).toBeNull();
	});
});

describe('plainTaskText', () => {
	it('drops metadata, counter and block id for the log', () => {
		expect(plainTaskText('Draft intro [kiri:: 2] 📅 2026-11-20 ^b1')).toBe('Draft intro');
		expect(plainTaskText('Read #book')).toBe('Read #book');
	});
});

describe('locateLine and replaceLine', () => {
	const doc = ['# Title', '- [ ] A', '- [ ] B', 'text', '- [ ] A'];

	it('finds a single line wherever it moved', () => {
		expect(locateLine(doc, '- [ ] B')).toBe(2);
		expect(locateLine(['new', ...doc], '- [ ] B')).toBe(3);
	});

	it('returns -1 when the line is gone', () => {
		expect(locateLine(doc, '- [ ] C')).toBe(-1);
	});

	it('replaces one line and keeps CRLF endings', () => {
		const result = replaceLine('a\r\n- [ ] B\r\nc', '- [ ] B', '- [x] B');
		expect(result).toEqual({ content: 'a\r\n- [x] B\r\nc', index: 1, copy: { copy: 0, copies: 1 } });
	});

	it('can replace one line with two (recurring tasks)', () => {
		const result = replaceLine('- [ ] B\nc\n', '- [ ] B', '- [ ] B next\n- [x] B');
		expect(result?.content).toBe('- [ ] B next\n- [x] B\nc\n');
	});

	it('changes nothing when the line is missing', () => {
		expect(replaceLine('a\nb', 'zzz', 'x')).toBeNull();
	});
});

describe('identical task lines (review 2, note safety S2)', () => {
	const doc = ['- [ ] Review', 'a', 'b', '- [ ] Review', 'c'];

	it('copyOf says which copy a line is', () => {
		expect(copyOf(doc, 0)).toEqual({ copy: 0, copies: 2 });
		expect(copyOf(doc, 3)).toEqual({ copy: 1, copies: 2 });
		expect(copyOf(doc, 1)).toEqual({ copy: 0, copies: 1 });
	});

	it('never guesses between copies without knowing which one', () => {
		expect(locateLine(doc, '- [ ] Review')).toBe(-1);
		expect(replaceLine(doc.join('\n'), '- [ ] Review', '- [x] Review')).toBeNull();
	});

	it('finds the right copy after many lines were added above it', () => {
		const moved = ['- [ ] Review', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'a', 'b', '- [ ] Review', 'c'];
		expect(locateLine(moved, '- [ ] Review', { copy: 1, copies: 2 })).toBe(43);
		const r = replaceLine(moved.join('\n'), '- [ ] Review', '- [x] Review', { copy: 1, copies: 2 });
		expect(r?.content.split('\n')[0]).toBe('- [ ] Review');
		expect(r?.content.split('\n')[43]).toBe('- [x] Review');
	});

	it('refuses when the number of copies changed', () => {
		const more = [...doc, '- [ ] Review'];
		expect(locateLine(more, '- [ ] Review', { copy: 1, copies: 2 })).toBe(-1);
	});

	it('a copy that became the only one is found', () => {
		expect(locateLine(['x', '- [ ] Review'], '- [ ] Review', { copy: 1, copies: 2 })).toBe(1);
	});
});

describe('logTaskText (review 2, note safety N1)', () => {
	it('keeps the words and drops tags, inline fields, links and Tasks fields', () => {
		expect(logTaskText('Write #work report [project:: Alpha] [[Client]] 📅 2026-11-20')).toBe('Write report Client');
		expect(logTaskText('Call [[People/Ann#Phone|Ann]] about (topic:: tax) ^b1')).toBe('Call Ann about');
		expect(logTaskText('Read [the spec](https://example.com) and ![[img.png]]')).toBe('Read the spec and img.png');
	});

	it('leaves a # that is not a tag', () => {
		expect(logTaskText('Fix issue #12 in C# code')).toBe('Fix issue #12 in C# code');
	});
});
