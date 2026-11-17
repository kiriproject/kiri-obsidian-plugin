export interface Heading {
	level: number;
	text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** A run of three or more backticks or tildes at the start of a line, and what follows it. */
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/** An open code fence: its character and length. */
export interface Fence {
	char: string;
	length: number;
}

/**
 * The fence a line opens, or null. As in CommonMark, a backtick fence's info
 * text may not hold a backtick, so a line such as ```` ```code``` ```` is inline
 * code, not a fence.
 */
export function fenceOpening(line: string): Fence | null {
	const m = FENCE_RE.exec(line);
	if (!m) return null;
	const run = m[1] ?? '';
	const char = run.charAt(0);
	if (char === '`' && (m[2] ?? '').includes('`')) return null;
	return { char, length: run.length };
}

/** True when the line closes `fence`: the same character, at least as long, nothing else after it. */
export function closesFence(line: string, fence: Fence): boolean {
	const m = FENCE_RE.exec(line);
	if (!m) return false;
	const run = m[1] ?? '';
	return run.charAt(0) === fence.char && run.length >= fence.length && (m[2] ?? '').trim().length === 0;
}

/**
 * Read a heading setting. "## Focus log" keeps its level;
 * plain "Focus log" becomes a level 2 heading. Empty input falls back to "## Focus log".
 */
export function parseHeadingSetting(input: string): Heading {
	const trimmed = input.trim();
	const m = HEADING_RE.exec(trimmed);
	if (m && (m[2] ?? '').length > 0) return { level: (m[1] ?? '##').length, text: m[2] ?? '' };
	const text = trimmed.replace(/^#+\s*/, '');
	return { level: 2, text: text.length > 0 ? text : 'Focus log' };
}

export function headingLine(h: Heading): string {
	return `${'#'.repeat(h.level)} ${h.text}`;
}

/** Lines with their own line endings, so a note with mixed endings keeps every one of them. */
function splitKeepingEnds(content: string): { lines: string[]; ends: string[] } {
	const parts = content.split(/(\r?\n)/);
	const lines: string[] = [];
	const ends: string[] = [];
	for (let i = 0; i < parts.length; i += 2) {
		lines.push(parts[i] ?? '');
		ends.push(parts[i + 1] ?? '');
	}
	return { lines, ends };
}

/** The line ending most used in the note ('\n' when there is none). */
function mainEnding(ends: readonly string[]): string {
	const crlf = ends.filter((e) => e === '\r\n').length;
	const lf = ends.filter((e) => e === '\n').length;
	return crlf > lf ? '\r\n' : '\n';
}

interface Section {
	/** Index of the heading line, or -1. */
	heading: number;
	/** Index of the first line after the section. */
	end: number;
	/** True when a code fence is still open at the end of the note. */
	unclosed: boolean;
}

/**
 * Find the section under `heading`. With `fences`, headings inside code
 * fences are skipped. `last` takes the last matching heading instead of the first.
 */
function findSection(lines: readonly string[], heading: Heading, fences: boolean, last: boolean): Section {
	const wanted = heading.text.trim().toLowerCase();
	let found = -1;
	let end = lines.length;
	let fence: Fence | null = null;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i] ?? '';
		if (fences) {
			if (fence) {
				if (closesFence(l, fence)) fence = null;
				continue;
			}
			const opened = fenceOpening(l);
			if (opened) {
				fence = opened;
				continue;
			}
		}
		const m = HEADING_RE.exec(l);
		if (!m) continue;
		const level = (m[1] ?? '').length;
		const matches = level === heading.level && (m[2] ?? '').trim().toLowerCase() === wanted;
		if (matches && (found === -1 || last)) {
			found = i;
			end = lines.length;
		} else if (found !== -1 && level <= heading.level && end === lines.length) {
			end = i;
			if (!last) break;
		}
	}
	return { heading: found, end, unclosed: fence !== null };
}

/**
 * Add `line` at the end of the section under `heading`.
 * If the heading is missing, it is added at the end of the note first.
 * Headings inside code fences are ignored. When a code fence is never closed
 * (so everything after it would count as code), a heading Kiri added at the
 * end of the note earlier is still found, so the note never gets a second one.
 * Each line keeps its own line ending.
 */
export function insertUnderHeading(content: string, heading: Heading, line: string): string {
	const { lines, ends } = splitKeepingEnds(content);
	const eol = mainEnding(ends);

	let section = findSection(lines, heading, true, false);
	if (section.heading === -1 && section.unclosed) section = findSection(lines, heading, false, true);

	if (section.heading === -1) {
		const body = content.replace(/\s+$/, '');
		const block = `${headingLine(heading)}${eol}${line}${eol}`;
		return body.length > 0 ? `${body}${eol}${eol}${block}` : block;
	}

	// Insert after the last non-blank line of the section.
	let insertAt = section.heading + 1;
	for (let i = section.end - 1; i > section.heading; i--) {
		if ((lines[i] ?? '').trim().length > 0) {
			insertAt = i + 1;
			break;
		}
	}
	const before = insertAt - 1;
	if (ends[before] === '') {
		// Added after the very last line of the note: it gets a line break, and so does the new line.
		ends[before] = eol;
	}
	lines.splice(insertAt, 0, line);
	ends.splice(insertAt, 0, ends[before] ?? eol);
	return lines.map((l, i) => `${l}${ends[i] ?? ''}`).join('');
}
