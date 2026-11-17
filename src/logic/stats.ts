/**
 * Focus stats from Kiri's own log lines. Pure functions: the vault code finds
 * the lines and the date of each daily note, these do the counting.
 * Dates are `YYYY-MM-DD` keys, so time zones and daylight saving never matter.
 */

export interface ParsedLogLine {
	/** Only set on lines in the fallback note, which has no date of its own. */
	date: string | null;
	minutes: number;
	label: string;
	/** Note name from the link, e.g. "Website relaunch". */
	note: string | null;
	task: string | null;
}

export interface FocusEntry {
	date: string;
	minutes: number;
	note: string | null;
}

export interface Totals {
	blocks: number;
	minutes: number;
}

export interface NoteMinutes {
	/** Note name, or null for blocks with no task note. */
	name: string | null;
	minutes: number;
	blocks: number;
}

export interface FocusStats {
	today: Totals;
	week: Totals;
	/** Days in a row with at least one block, up to today (or yesterday if today has none yet). */
	streak: number;
}

export type StatsRange = 'week' | 'month' | 'all';

/** Longest block Kiri can log; caps blocks that were paused for a long time. */
const MAX_BLOCK_MINUTES = 120;

const LINE_RE = /^\s*[-*+]\s+(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})\s+·\s+(.+)$/;

/** Read one Kiri log line, e.g. `- 10:00–10:25 · Focus · [[Plan]] · Write intro`. Null for other lines. */
export function parseLogLine(line: string): ParsedLogLine | null {
	const m = LINE_RE.exec(line);
	if (!m) return null;
	const start = Number(m[2]) * 60 + Number(m[3]);
	let end = Number(m[4]) * 60 + Number(m[5]);
	if (end < start) end += 24 * 60; // Past midnight.
	const parts = (m[6] ?? '').split(' · ').map((p) => p.trim());
	let label = parts.shift() ?? '';
	let minutes = Math.min(MAX_BLOCK_MINUTES, end - start);
	// `Focus (25m)`: the block was paused, so the clock times include the pause.
	const own = /^(.*?)\s*\((\d{1,3})m\)$/.exec(label);
	if (own) {
		label = own[1] ?? '';
		minutes = Math.min(MAX_BLOCK_MINUTES, Number(own[2]));
	}
	if (!label) return null;
	let note: string | null = null;
	if (parts.length > 0 && isLink(parts[0] ?? '')) note = linkName(parts.shift() ?? '');
	const task = parts.join(' · ').trim();
	return {
		date: m[1] ?? null,
		minutes,
		label,
		note,
		task: task.length > 0 ? task : null,
	};
}

function isLink(text: string): boolean {
	return /^\[\[[^\]]+\]\]$/.test(text) || /^\[[^\]]*\]\([^)]*\)$/.test(text);
}

/** `[[Folder/Plan|alias]]` → "Plan"; `[Plan](Folder/Plan.md)` → "Plan". */
export function linkName(link: string): string {
	const wiki = /^\[\[([^\]|#]+)/.exec(link);
	if (wiki) return (wiki[1] ?? '').split('/').pop()?.replace(/\.md$/, '').trim() ?? '';
	const md = /^\[([^\]]*)\]/.exec(link);
	return (md?.[1] ?? link).trim();
}

/** Focus entries from the lines of a note. `date` is the daily note's date, or null for the fallback note. */
export function entriesFromNote(content: string, date: string | null): FocusEntry[] {
	const out: FocusEntry[] = [];
	for (const line of content.split(/\r?\n/)) {
		const parsed = parseLogLine(line);
		if (!parsed || parsed.label !== 'Focus') continue;
		const day = parsed.date ?? date;
		if (!day) continue;
		out.push({ date: day, minutes: parsed.minutes, note: parsed.note });
	}
	return out;
}

/** Add days to a `YYYY-MM-DD` key. */
export function addDays(key: string, days: number): string {
	const [y, m, d] = key.split('-').map(Number);
	const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000);
	return date.toISOString().slice(0, 10);
}

/** The Monday of the week that holds this day. */
export function weekStart(key: string): string {
	const [y, m, d] = key.split('-').map(Number);
	const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay(); // 0 = Sunday
	return addDays(key, -((weekday + 6) % 7));
}

function totals(entries: readonly FocusEntry[]): Totals {
	return { blocks: entries.length, minutes: entries.reduce((sum, e) => sum + e.minutes, 0) };
}

export function computeStats(entries: readonly FocusEntry[], today: string): FocusStats {
	const monday = weekStart(today);
	const days = new Set(entries.map((e) => e.date));
	let day = days.has(today) ? today : addDays(today, -1);
	let streak = 0;
	while (days.has(day)) {
		streak++;
		day = addDays(day, -1);
	}
	return {
		today: totals(entries.filter((e) => e.date === today)),
		week: totals(entries.filter((e) => e.date >= monday && e.date <= today)),
		streak,
	};
}

/** First day included in a range, or null for all time. */
export function rangeStart(range: StatsRange, today: string): string | null {
	if (range === 'week') return weekStart(today);
	if (range === 'month') return addDays(today, -29);
	return null;
}

/** Minutes per note in a range, most minutes first. Blocks with no note come last. */
export function minutesByNote(entries: readonly FocusEntry[], range: StatsRange, today: string): NoteMinutes[] {
	const from = rangeStart(range, today);
	const byName = new Map<string | null, NoteMinutes>();
	for (const e of entries) {
		if (e.date > today || (from && e.date < from)) continue;
		const row = byName.get(e.note) ?? { name: e.note, minutes: 0, blocks: 0 };
		row.minutes += e.minutes;
		row.blocks += 1;
		byName.set(e.note, row);
	}
	return [...byName.values()].sort((a, b) => {
		if ((a.name === null) !== (b.name === null)) return a.name === null ? 1 : -1;
		return b.minutes - a.minutes || (a.name ?? '').localeCompare(b.name ?? '');
	});
}
