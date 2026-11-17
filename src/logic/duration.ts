export const MIN_MINUTES = 5;
export const MAX_MINUTES = 120;
export const PRESET_LENGTHS = [25, 50, 90] as const;
export const MIN_BREAK_MINUTES = 1;
export const MAX_BREAK_MINUTES = 60;
/** Break presets in the panel, next to Auto. */
export const BREAK_PRESETS = [5, 10, 15, 17] as const;

export interface BreakLengths {
	/** Break after blocks up to 25 minutes. */
	short: number;
	/** Break after blocks up to 50 minutes. */
	medium: number;
	/** Break after longer blocks. */
	long: number;
}

/**
 * Turn user input into a whole number of minutes between min and max.
 * Returns null when the input is not a number at all.
 */
export function clampMinutes(
	input: string | number,
	min: number = MIN_MINUTES,
	max: number = MAX_MINUTES,
): number | null {
	const value = typeof input === 'number' ? input : Number.parseFloat(input.trim());
	if (!Number.isFinite(value)) return null;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Pick the break length for a focus block.
 * 25 or less gets the short break, up to 50 the medium one, anything longer the long one.
 */
export function breakMinutesFor(focusMinutes: number, breaks: BreakLengths): number {
	if (focusMinutes <= 25) return breaks.short;
	if (focusMinutes <= 50) return breaks.medium;
	return breaks.long;
}

/** Format milliseconds as mm:ss (minutes are not wrapped, so 90 minutes is 90:00). */
export function formatCountdown(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** Format a time of day as HH:mm (24-hour). */
export function formatClock(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function minutesToMs(minutes: number): number {
	return Math.round(minutes * 60_000);
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/**
 * Read a number typed in a settings field, when the field is left or Enter is
 * pressed. Returns the value to use and the text to put back in the field
 * (the value clamped to its range), with a short message when the input was
 * changed or could not be read (then the current value stays).
 */
export function readNumberField(input: string, min: number, max: number, current: number): { value: number; text: string; message: string | null } {
	const parsed = clampMinutes(input, min, max);
	if (parsed === null) return { value: current, text: String(current), message: `Enter a number from ${min} to ${max}. Kept ${current}.` };
	const exact = Number.parseFloat(input.trim());
	const message = exact === parsed ? null : `Set to ${parsed}: the range is ${min} to ${max}.`;
	return { value: parsed, text: String(parsed), message };
}
