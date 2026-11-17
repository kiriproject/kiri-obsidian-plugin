import { describe, expect, it } from 'vitest';
import { closesFence, fenceOpening, insertUnderHeading, parseHeadingSetting } from '../src/logic/heading';

const H = { level: 2, text: 'Focus log' };
const L = '- 10:00–10:25 · Focus';

describe('parseHeadingSetting', () => {
	it('keeps the level from the setting', () => {
		expect(parseHeadingSetting('### Log')).toEqual({ level: 3, text: 'Log' });
	});
	it('defaults to level 2', () => {
		expect(parseHeadingSetting('Focus log')).toEqual({ level: 2, text: 'Focus log' });
		expect(parseHeadingSetting('   ')).toEqual({ level: 2, text: 'Focus log' });
	});
});

describe('insertUnderHeading', () => {
	it('creates the heading in an empty note', () => {
		expect(insertUnderHeading('', H, L)).toBe(`## Focus log\n${L}\n`);
	});

	it('adds the heading at the end when missing', () => {
		expect(insertUnderHeading('# 2026-11-14\n\nNotes here\n\n', H, L)).toBe(`# 2026-11-14\n\nNotes here\n\n## Focus log\n${L}\n`);
	});

	it('appends after the last entry of the section', () => {
		const doc = '## Focus log\n- 09:00–09:25 · Focus\n\n## Notes\nhello\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`## Focus log\n- 09:00–09:25 · Focus\n${L}\n\n## Notes\nhello\n`);
	});

	it('handles a section at the end without a final line break', () => {
		expect(insertUnderHeading('## Focus log\n- a', H, L)).toBe(`## Focus log\n- a\n${L}\n`);
	});

	it('keeps subheadings inside the section', () => {
		const doc = '## Focus log\n### Morning\n- a\n## Other\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`## Focus log\n### Morning\n- a\n${L}\n## Other\n`);
	});

	it('matches the heading text without case and ignores other levels', () => {
		const doc = '### Focus log\n- x\n## focus LOG\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`### Focus log\n- x\n## focus LOG\n${L}\n`);
	});

	it('ignores headings inside code fences', () => {
		const doc = '```\n## Focus log\n```\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`\`\`\`\n## Focus log\n\`\`\`\n\n## Focus log\n${L}\n`);
	});


	it('keeps CRLF line endings', () => {
		expect(insertUnderHeading('## Focus log\r\n- a\r\n', H, L)).toBe(`## Focus log\r\n- a\r\n${L}\r\n`);
	});
});

describe('code fences (review 2, note safety S3)', () => {
	it('reads fences like CommonMark', () => {
		expect(fenceOpening('```js')).toEqual({ char: '`', length: 3 });
		expect(fenceOpening('  ~~~~')).toEqual({ char: '~', length: 4 });
		expect(fenceOpening('```code``` inline')).toBeNull();
		expect(fenceOpening('`` not a fence')).toBeNull();
		expect(closesFence('````', { char: '`', length: 4 })).toBe(true);
		expect(closesFence('```', { char: '`', length: 4 })).toBe(false);
		expect(closesFence('~~~', { char: '`', length: 3 })).toBe(false);
		expect(closesFence('``` js', { char: '`', length: 3 })).toBe(false);
	});

	it('a four-backtick block holding a three-backtick line ends at its own fence', () => {
		const doc = '````md\n```\n## Focus log\n````\n\n## Focus log\n- a\n';
		const once = insertUnderHeading(doc, H, L);
		expect(once).toBe(`\`\`\`\`md\n\`\`\`\n## Focus log\n\`\`\`\`\n\n## Focus log\n- a\n${L}\n`);
		expect(once.match(/^## Focus log$/gm)).toHaveLength(2);
	});

	it('a line starting with inline ```code``` does not open a fence', () => {
		const doc = '```code``` is inline\n\n## Focus log\n- a\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`\`\`\`code\`\`\` is inline\n\n## Focus log\n- a\n${L}\n`);
	});

	it('a tilde fence is not closed by backticks', () => {
		const doc = '~~~\n```\n## Focus log\n~~~\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`~~~\n\`\`\`\n## Focus log\n~~~\n\n## Focus log\n${L}\n`);
	});

	it('a fence that is never closed gets one heading at the end, never a second one', () => {
		let doc = '# Day\n```\nunfinished code\n';
		for (let i = 0; i < 3; i++) doc = insertUnderHeading(doc, H, `${L} ${i}`);
		expect(doc).toBe(`# Day\n\`\`\`\nunfinished code\n\n## Focus log\n${L} 0\n${L} 1\n${L} 2\n`);
		expect(doc.match(/^## Focus log$/gm)).toHaveLength(1);
	});

	it('repeated blocks never add the heading twice in a note with fences', () => {
		let doc = '````\n```\n## Focus log\n````\n~~~\n# x\n~~~\n```code```\n';
		for (let i = 0; i < 3; i++) doc = insertUnderHeading(doc, H, `${L} ${i}`);
		expect(doc.match(/^## Focus log$/gm)).toHaveLength(2);
		expect(doc.endsWith(`## Focus log\n${L} 0\n${L} 1\n${L} 2\n`)).toBe(true);
	});
});

describe('mixed line endings (review 2, note safety N3)', () => {
	it('finds the heading and keeps each line its own ending', () => {
		const doc = '# Day\r\nnotes\n## Focus log\n- a\n';
		expect(insertUnderHeading(doc, H, L)).toBe(`# Day\r\nnotes\n## Focus log\n- a\n${L}\n`);
	});

	it('a CRLF note keeps CRLF on the new line', () => {
		expect(insertUnderHeading('## Focus log\r\n- a\r\n\r\n## Next\r\n', H, L)).toBe(`## Focus log\r\n- a\r\n${L}\r\n\r\n## Next\r\n`);
	});
});

