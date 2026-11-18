import { type App, normalizePath, TFile } from 'obsidian';
import { type DateValue, moment } from '../time';
import { insertUnderHeading, parseHeadingSetting } from '../logic/heading';
import { applyDailyTemplate } from '../logic/template';

export const FALLBACK_LOG_NOTE = 'Kiri focus log.md';
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

export interface DailyNotesConfig {
	enabled: boolean;
	format: string;
	folder: string;
	template: string;
}

interface DailyNotesInternal {
	enabled?: boolean;
	instance?: { options?: { format?: string; folder?: string; template?: string } };
}

interface AppWithInternalPlugins {
	internalPlugins?: { getPluginById?: (id: string) => DailyNotesInternal | null | undefined };
}

/**
 * Read the core Daily notes plugin settings. Obsidian has no public API for this,
 * so we read the core plugin's options the same way most community plugins do.
 * Anything missing falls back to the core defaults.
 */
export function readDailyNotesConfig(app: App): DailyNotesConfig {
	const plugin = (app as unknown as AppWithInternalPlugins).internalPlugins?.getPluginById?.('daily-notes');
	const options = plugin?.instance?.options ?? {};
	return {
		enabled: plugin?.enabled === true,
		format: options.format?.trim() || DEFAULT_DATE_FORMAT,
		folder: options.folder?.trim() ?? '',
		template: options.template?.trim() ?? '',
	};
}

/** Why a log line went to the fallback note instead of today's daily note. */
export type FallbackReason = 'daily-notes-off' | 'daily-note-missing' | 'template-missing';

export interface LogTarget {
	file: TFile;
	/** True for the fallback note: its lines carry their date (daily notes have it in their name). */
	dated: boolean;
	/** Set when the line goes to the fallback note. */
	reason?: FallbackReason;
	/** The template path that could not be found (reason 'template-missing'). */
	template?: string;
}

export interface LogNoteOptions {
	/**
	 * Create today's daily note (from the Daily notes template) when it does not
	 * exist yet. Off by default: the line then goes to the fallback note, so Kiri
	 * never makes a second "today" note before a sync service brings the real one.
	 */
	createDailyNote: boolean;
}

/** The path of today's daily note, from the Daily notes settings. */
export function dailyNotePath(config: DailyNotesConfig, now: DateValue = moment()): string {
	const name = now.format(config.format);
	return normalizePath(config.folder ? `${config.folder}/${name}.md` : `${name}.md`);
}

/**
 * Where a log line goes: today's daily note if it exists; otherwise, only
 * when `createDailyNote` is on and the template (if one is set) can be found,
 * a new daily note from that template; in every other case the fallback note
 * `Kiri focus log.md`. A daily note is never created empty because its
 * template went missing.
 */
export async function getLogNote(app: App, options: LogNoteOptions): Promise<LogTarget> {
	const config = readDailyNotesConfig(app);
	const fallback = async (reason: FallbackReason, template?: string): Promise<LogTarget> => {
		const file = await getOrCreate(app, normalizePath(FALLBACK_LOG_NOTE), async () => '');
		return template === undefined ? { file, dated: true, reason } : { file, dated: true, reason, template };
	};
	if (!config.enabled) return fallback('daily-notes-off');

	const now = moment();
	const path = dailyNotePath(config, now);
	// Looked up right before any create, so a note that arrived meanwhile (sync) is used.
	const existing = app.vault.getFileByPath(path);
	if (existing) return { file: existing, dated: false };
	if (!options.createDailyNote) return fallback('daily-note-missing');

	let template = '';
	if (config.template) {
		const templatePath = normalizePath(config.template.endsWith('.md') ? config.template : `${config.template}.md`);
		const templateFile = app.vault.getFileByPath(templatePath);
		if (!templateFile) return fallback('template-missing', templatePath);
		template = await app.vault.cachedRead(templateFile);
	}
	const name = now.format(config.format);
	const title = name.split('/').pop() ?? name;
	const file = await getOrCreate(app, path, async () =>
		config.template ? applyDailyTemplate(template, title, config.format, (pattern) => now.format(pattern)) : '',
	);
	return { file, dated: false };
}

/** Add a log line under the heading in the given note, atomically. */
export async function appendLogLine(app: App, file: TFile, headingSetting: string, line: string): Promise<void> {
	const heading = parseHeadingSetting(headingSetting);
	await app.vault.process(file, (data) => insertUnderHeading(data, heading, line));
}

async function getOrCreate(app: App, path: string, initial: () => Promise<string>): Promise<TFile> {
	const existing = app.vault.getFileByPath(path);
	if (existing) return existing;
	const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	if (folder && !app.vault.getFolderByPath(folder)) {
		try {
			await app.vault.createFolder(folder);
		} catch {
			// Created in the meantime.
		}
	}
	try {
		return await app.vault.create(path, await initial());
	} catch (err) {
		const raced = app.vault.getAbstractFileByPath(path);
		if (raced instanceof TFile) return raced;
		throw err;
	}
}
