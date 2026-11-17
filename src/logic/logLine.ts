import { formatClock } from './duration';

export interface LogEntry {
	/** `YYYY-MM-DD`, written only to the fallback note (daily notes already carry the date). */
	date?: string;
	start: Date;
	end: Date;
	/** Usually "Focus". */
	label: string;
	/** A ready-made link to the task's note, e.g. `[[Project plan]]`. */
	link?: string;
	/** Task words, already cleaned of metadata. */
	task?: string;
	/**
	 * Focus minutes, written after the label (`Focus (25m)`) when they differ
	 * from the clock times, for example after a pause. Stats prefer this number.
	 */
	minutes?: number;
}

/**
 * `- 10:00–10:25 · Focus · [[Note name]] · task text` (parts left out when empty).
 * With a date: `- 2026-11-15 10:00–10:25 · Focus · ...`.
 * After a pause: `- 10:00–11:05 · Focus (25m) · ...`.
 */
export function formatLogLine(entry: LogEntry): string {
	const time = `${formatClock(entry.start)}–${formatClock(entry.end)}`;
	const label = entry.minutes !== undefined ? `${entry.label} (${Math.round(entry.minutes)}m)` : entry.label;
	const parts = [entry.date ? `${entry.date} ${time}` : time, label];
	if (entry.link) parts.push(entry.link);
	const task = entry.task?.trim();
	if (task) parts.push(task);
	return `- ${parts.join(' · ')}`;
}
