import { moment as obsidianMoment } from 'obsidian';

/** The parts of a moment Kiri uses. */
export interface DateValue {
	format(pattern?: string): string;
	isValid(): boolean;
}

type DateFactory = (input?: number | string | Date, format?: string, strict?: boolean) => DateValue;

/**
 * Obsidian's bundled moment, behind a small typed surface. Its type comes from the
 * separate moment package, which is not always resolved (then it is `any`), so every
 * use goes through this one typed name.
 */
const bundled: unknown = obsidianMoment;
export const moment = bundled as DateFactory;
