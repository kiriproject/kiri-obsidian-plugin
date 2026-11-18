import { type App, normalizePath } from 'obsidian';
import { moment } from '../time';
import { entriesFromNote, type FocusEntry } from '../logic/stats';
import { FALLBACK_LOG_NOTE, readDailyNotesConfig } from './dailyNote';

/**
 * All focus blocks Kiri has logged: lines in daily notes (dated by the note's name,
 * using the Daily notes date format) and dated lines in the fallback note.
 * Only reads notes; never changes them.
 */
export async function collectFocusEntries(app: App): Promise<FocusEntry[]> {
	const config = readDailyNotesConfig(app);
	const entries: FocusEntry[] = [];
	const folder = config.folder ? `${normalizePath(config.folder)}/` : '';
	const fallbackPath = normalizePath(FALLBACK_LOG_NOTE);

	for (const file of app.vault.getMarkdownFiles()) {
		if (file.path === fallbackPath) continue;
		if (folder && !file.path.startsWith(folder)) continue;
		const name = file.path.slice(folder.length).replace(/\.md$/, '');
		const date = moment(name, config.format, true);
		if (!date.isValid()) continue;
		entries.push(...entriesFromNote(await app.vault.cachedRead(file), date.format('YYYY-MM-DD')));
	}

	const fallback = app.vault.getFileByPath(fallbackPath);
	if (fallback) entries.push(...entriesFromNote(await app.vault.cachedRead(fallback), null));
	return entries;
}

export function todayKey(): string {
	return moment().format('YYYY-MM-DD');
}
