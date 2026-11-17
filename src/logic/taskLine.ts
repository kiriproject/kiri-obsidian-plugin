/**
 * Pure helpers for Markdown task lines such as `- [ ] Draft intro 📅 2026-11-20`.
 * Nothing here touches the vault. No lookbehind in regexes (older iOS WebViews lack it).
 */

export interface ParsedTask {
	/** Everything before the status character, e.g. `  - [`. */
	prefix: string;
	/** The status character: ' ' for open, 'x' for done, others for custom states. */
	status: string;
	/** Text after `] `, unchanged. */
	text: string;
}

// Optional blockquote markers, indentation, a bullet or numbered marker, then [status].
const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)(.)\](?:\s+(.*))?$/;

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const ID_VALUE = /^[A-Za-z0-9_-]+$/;

/**
 * Emoji markers the Tasks plugin reads from the end of a task line, with the
 * shape of the value that follows each one. An emoji whose following text does
 * not have that shape is part of the task's words, not a field.
 */
const TASKS_SIGNIFIERS: readonly (readonly [string, RegExp])[] = [
	['📅', DATE_VALUE],
	['⏳', DATE_VALUE],
	['🛫', DATE_VALUE],
	['➕', DATE_VALUE],
	['✅', DATE_VALUE],
	['❌', DATE_VALUE],
	['🔁', /^every\b/i],
	['🔺', /^$/],
	['⏫', /^$/],
	['🔼', /^$/],
	['🔽', /^$/],
	['⏬', /^$/],
	['🆔', ID_VALUE],
	['⛔', /^[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*$/],
	['🏁', /^(?:delete|keep)$/i],
];

/**
 * A Tasks plugin field in its Dataview format at the end of the text, e.g.
 * `[due:: 2026-11-20]` or `(priority:: high)`.
 */
const TASKS_DATAVIEW_FIELD_END_RE =
	/[[(](?:created|scheduled|start|due|completion|cancelled|priority|repeat|onCompletion|id|dependsOn)::[^\])]*[\])]$/;
/** A tag at the end of the text; the Tasks plugin allows tags among its trailing fields. */
const TRAILING_TAG_RE = /(?:^|\s)#[^\s#]+$/;

const COUNTER_RE = /\s*\[kiri::\s*(\d+)\s*\]/;
/** Any `[kiri:: ...]` field, readable or not. */
const ANY_COUNTER_RE = /\[kiri::[^\]]*\]/;
const SPENT_RE = /\s*\[spent::\s*([^\]]*?)\s*\]/;
const PLANNED_RE = /\s*\[(?:planned|estimate)::\s*([^\]]*?)\s*\]/;
/** Inline fields Kiri writes or reads; left out of the focus log text. */
const KIRI_FIELDS_RE = /\s*\[(?:kiri|spent|planned|estimate)::[^\]]*\]/g;
const BLOCK_ID_RE = /\s+\^[A-Za-z0-9-]+\s*$/;

export function parseTaskLine(line: string): ParsedTask | null {
	const m = TASK_RE.exec(line);
	if (!m) return null;
	return { prefix: m[1] ?? '', status: m[2] ?? ' ', text: m[3] ?? '' };
}

export function isOpenTask(line: string): boolean {
	const parsed = parseTaskLine(line);
	return parsed !== null && parsed.status === ' ';
}

/**
 * Index in `text` where trailing metadata starts (Tasks emoji fields, Tasks
 * Dataview-format fields or a block id), or text.length. Like the Tasks plugin,
 * it reads fields from the end of the line, so an emoji used inside the task's
 * own words (`Review ✅ checklist`) is not taken for a field.
 */
export function metadataStart(text: string): number {
	let cut = text.length;
	const block = BLOCK_ID_RE.exec(text);
	if (block) cut = block.index;
	let fieldCut = cut;
	let pos = cut;
	for (;;) {
		const head = text.slice(0, pos).replace(/\s+$/, '');
		if (head.length === 0) break;
		const dataview = TASKS_DATAVIEW_FIELD_END_RE.exec(head);
		if (dataview) {
			pos = dataview.index;
			fieldCut = pos;
			continue;
		}
		const emoji = trailingSignifier(head);
		if (emoji !== null) {
			pos = emoji;
			fieldCut = pos;
			continue;
		}
		const tag = TRAILING_TAG_RE.exec(head);
		if (tag) {
			// Tags count as metadata only when a field comes before them.
			pos = tag.index;
			continue;
		}
		break;
	}
	return fieldCut;
}

/** Start of a Tasks emoji field (emoji plus a valid value) that ends `head`, or null. */
function trailingSignifier(head: string): number | null {
	let best: number | null = null;
	for (const [emoji, valueRe] of TASKS_SIGNIFIERS) {
		const i = head.lastIndexOf(emoji);
		if (i === -1) continue;
		const value = head
			.slice(i + emoji.length)
			.replace(/^\uFE0F/, '')
			.trim();
		if (!valueRe.test(value)) continue;
		// The nearest field to the end wins, so the value never spans another field.
		if (best === null || i > best) best = i;
	}
	return best;
}

/** Read the `[kiri:: N]` counter from a line; 0 when absent. */
export function readCounter(line: string): number {
	const m = COUNTER_RE.exec(line);
	return m ? Number.parseInt(m[1] ?? '0', 10) : 0;
}

/**
 * Set an inline field such as `[spent:: 50m]` on a task line.
 * An existing field with the same key is updated in place. A new field goes after
 * the task's own words (and after other Kiri fields) but before any Tasks plugin
 * emoji or Dataview-format fields and the block id, so the Tasks plugin still
 * reads its dates. Returns null if the line is not a task. Setting the same value
 * twice gives the same line.
 */
export function setInlineField(line: string, key: string, value: string): string | null {
	const parsed = parseTaskLine(line);
	if (!parsed) return null;
	const fieldRe = new RegExp(`\\s*\\[${escapeRegExp(key)}::[^\\]]*\\]`);
	const field = `[${key}:: ${value}]`;
	if (fieldRe.test(parsed.text)) {
		const text = parsed.text.replace(fieldRe, (whole) => `${/^\s*/.exec(whole)?.[0] ?? ' '}${field}`);
		return `${parsed.prefix}${parsed.status}] ${text}`;
	}
	const cut = metadataStart(parsed.text);
	const head = parsed.text.slice(0, cut).replace(/\s+$/, '');
	const tail = parsed.text.slice(cut).replace(/^\s+/, '');
	const parts = [head, field, tail].filter((p) => p.length > 0);
	return `${parsed.prefix}${parsed.status}] ${parts.join(' ')}`;
}

/**
 * Remove Kiri's own `[kiri:: ...]` and `[spent:: ...]` fields from a task line,
 * keeping everything else (and `[planned:: ...]`, which the user writes).
 */
export function withoutKiriCounters(line: string): string {
	const parsed = parseTaskLine(line);
	if (!parsed) return line;
	const text = parsed.text.replace(/\s*\[(?:kiri|spent)::[^\]]*\]/g, '').replace(/^\s+/, '');
	return `${parsed.prefix}${parsed.status}]${text.length > 0 ? ` ${text}` : ''}`;
}

/**
 * Add one to the `[kiri:: N]` inline field on a task line (see setInlineField for placement).
 * Returns null if the line is not a task, or if it has a `[kiri:: ...]` field Kiri
 * cannot read (so text the user wrote there is never overwritten).
 */
export function incrementCounter(line: string): string | null {
	if (hasUnreadableCounter(line)) return null;
	return setInlineField(line, 'kiri', String(readCounter(line) + 1));
}

/** True when the line has a `[kiri:: ...]` field that is not a whole number. */
export function hasUnreadableCounter(line: string): boolean {
	return ANY_COUNTER_RE.test(line) && !COUNTER_RE.test(line);
}

/** Minutes in `[spent:: 1h 15m]`; 0 when absent or unreadable. */
export function readSpent(line: string): number {
	const m = SPENT_RE.exec(line);
	return m ? (parseDurationText(m[1] ?? '') ?? 0) : 0;
}

/** Minutes in `[planned:: 2h]` or `[estimate:: 90m]`; null when absent or unreadable. */
export function readPlanned(line: string): number | null {
	const m = PLANNED_RE.exec(line);
	return m ? parseDurationText(m[1] ?? '') : null;
}

/** Write the total spent time, e.g. `[spent:: 1h 15m]`. Idempotent for the same total. */
export function setSpent(line: string, totalMinutes: number): string | null {
	return setInlineField(line, 'spent', formatDurationText(Math.max(0, Math.round(totalMinutes))));
}

/**
 * Add a block's minutes to `[spent:: ...]`. Returns null if the line is not a task,
 * or if its spent field holds something Kiri cannot read (such as `1:30` or `~2h`),
 * so a value the user typed is never replaced.
 */
export function addSpent(line: string, minutes: number): string | null {
	if (hasUnreadableSpent(line)) return null;
	return setSpent(line, readSpent(line) + minutes);
}

/** True when the line has a `[spent:: ...]` field whose value cannot be read as a duration. */
export function hasUnreadableSpent(line: string): boolean {
	const m = SPENT_RE.exec(line);
	return m !== null && parseDurationText(m[1] ?? '') === null;
}

/**
 * Read a duration such as `90`, `90m`, `90 min`, `1h`, `1.5h`, `1h 30m` or `2 hours`.
 * A plain number means minutes. Returns whole minutes, or null when it cannot be read.
 */
export function parseDurationText(input: string): number | null {
	const text = input.trim().toLowerCase();
	if (!text) return null;
	if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number.parseFloat(text));
	const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/g;
	let total = 0;
	let found = false;
	let rest = text;
	for (const m of text.matchAll(re)) {
		found = true;
		const n = Number.parseFloat(m[1] ?? '0');
		total += (m[2] ?? 'm').startsWith('h') ? n * 60 : n;
		rest = rest.replace(m[0], '');
	}
	if (!found || rest.replace(/[\s,]+/g, '').length > 0) return null;
	return Math.round(total);
}

/** `45m`, `1h`, `1h 15m`. Read back by parseDurationText and by Dataview. */
export function formatDurationText(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	const h = Math.floor(m / 60);
	const rest = m % 60;
	if (h === 0) return `${rest}m`;
	return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn an open task into a done task by changing `[ ]` to `[x]`. Other text is kept as is. */
export function markDonePlain(line: string): string | null {
	const parsed = parseTaskLine(line);
	if (!parsed || parsed.status !== ' ') return null;
	const rest = parsed.text.length > 0 ? ` ${parsed.text}` : '';
	return `${parsed.prefix}x]${rest}`;
}

/**
 * Short task text for the focus log: the task's words without Tasks
 * fields, block id or Kiri's own fields. The note itself is not changed.
 */
export function plainTaskText(text: string): string {
	const withoutCounter = text.replace(KIRI_FIELDS_RE, '');
	return withoutCounter.slice(0, metadataStart(withoutCounter)).replace(/\s+/g, ' ').trim();
}

/** Any inline field such as `[project:: Alpha]` or `(due:: 2026-11-20)`. */
const INLINE_FIELD_RE = /[[(][^[\]()]*?::[^\])]*[\])]/g;
/** `[[Target]]`, `[[Target|Alias]]` or `![[Target]]`. */
const WIKILINK_RE = /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
/** `[text](target)` or `![text](target)`. */
const MD_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
/** A tag: `#` after a space or the start, holding at least one character that is not a digit. */
const TAG_RE = /(^|\s)#(?=[^\s#]*[^\d\s#])[^\s#]+/g;

/**
 * The task's words as plain text for the focus log (and the block sent to a
 * Kiri account): plainTaskText without tags, inline fields of any name and
 * links (a link keeps its text). So the daily note gets no extra tags, fields
 * or backlinks from the task; the log line's own link to the task's note is
 * added separately.
 */
export function logTaskText(text: string): string {
	return plainTaskText(text)
		.replace(INLINE_FIELD_RE, ' ')
		.replace(WIKILINK_RE, (_whole, target: string, alias?: string) => (alias ?? target.split('#')[0] ?? target).trim())
		.replace(MD_LINK_RE, '$1')
		.replace(TAG_RE, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Which of several identical lines a task is: `copy` is its place (from 0)
 * among the lines with exactly its text, `copies` how many there were.
 */
export interface LineCopy {
	copy: number;
	copies: number;
}

/** Where line `index` stands among the lines with exactly its text. */
export function copyOf(lines: readonly string[], index: number): LineCopy {
	const text = lines[index];
	let copy = 0;
	let copies = 0;
	lines.forEach((l, i) => {
		if (l !== text) return;
		if (i < index) copy++;
		copies++;
	});
	return { copy, copies };
}

/**
 * Find a task line again before reading or editing it. Never guesses:
 * - one line with exactly the expected text: that line;
 * - several identical lines: the one at the same place among them (`where`),
 *   if the note still has the same number of copies; lines added or removed
 *   elsewhere do not matter, so this works however far the line moved;
 * - otherwise (no copies left, or the number of copies changed, or no `where`
 *   is known): -1, so nothing is changed and Kiri says it could not find the task.
 * The line number a task was last seen at is not used: a remembered number
 * can point at another identical line once lines move.
 */
export function locateLine(lines: readonly string[], expected: string, where?: Partial<LineCopy>): number {
	const matches: number[] = [];
	lines.forEach((l, i) => {
		if (l === expected) matches.push(i);
	});
	if (matches.length === 0) return -1;
	if (matches.length === 1) return matches[0] ?? -1;
	if (where && where.copies === matches.length && typeof where.copy === 'number') return matches[where.copy] ?? -1;
	return -1;
}

/** Split text into lines and remember the line ending so a rewrite keeps it. */
export function splitLines(content: string): { lines: string[]; eol: string } {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	return { lines: content.split(eol), eol };
}

/**
 * Replace one line, if it can still be found without doubt (see locateLine).
 * Returns the new content, the index used and the new line's place among
 * identical lines, or null when the line can no longer be found.
 * `replacement` may contain a line break (the Tasks plugin adds a new line for recurring tasks).
 */
export function replaceLine(
	content: string,
	expected: string,
	replacement: string,
	where?: Partial<LineCopy>,
): { content: string; index: number; copy: LineCopy } | null {
	const { lines, eol } = splitLines(content);
	const index = locateLine(lines, expected, where);
	if (index === -1) return null;
	const replacementLines = replacement.split(/\r?\n/);
	lines.splice(index, 1, ...replacementLines);
	return { content: lines.join(eol), index, copy: copyOf(lines, index) };
}
