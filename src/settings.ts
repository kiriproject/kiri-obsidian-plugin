import { type BinauralChoice, isBeatKey } from './audio/binaural';
import type { NoiseKind } from './audio/noiseGen';
import { isSafeSoundKey } from './audio/soundCache';
import type { BreakLengths } from './logic/duration';

/** 'off', a noise made on the device, or a Kiri recording ('kiri:rain', needs a connected account). */
export type SoundChoice = 'off' | NoiseKind | `kiri:${string}`;

/** The sounds that work without an account. */
export const SOUND_LABELS: Record<'off' | NoiseKind, string> = {
	off: 'Off',
	brown: 'Brown noise',
	pink: 'Pink noise',
	white: 'White noise',
};

export type ChimeStyle = 'bell' | 'soft';

export const CHIME_LABELS: Record<ChimeStyle, string> = {
	bell: 'Bell (two notes)',
	soft: 'Soft (one low note, quieter)',
};

export interface KiriSettings {
	/** Length of a focus block in minutes (also remembered from the view). */
	focusMinutes: number;
	breaksEnabled: boolean;
	/** Break after every block in minutes (1–60), or null for Auto: by block length, from `breaks`. */
	breakMinutes: number | null;
	/** Break lengths by block length; only used while `breakMinutes` is Auto. */
	breaks: BreakLengths;
	autoStartNext: boolean;
	/** Start the break by itself when a block ends (otherwise wait for a click). */
	autoStartBreak: boolean;
	longBreakEnabled: boolean;
	longBreakMinutes: number;
	longBreakEvery: number;
	chime: boolean;
	chimeStyle: ChimeStyle;
	sound: SoundChoice;
	/** 0..100 */
	volume: number;
	/** Binaural tones; only offered with a Kiri account that includes them. */
	binaural: BinauralChoice;
	/** 0..100, capped further by the player. */
	binauralVolume: number;
	/** Send finished blocks to the connected Kiri account. */
	syncEnabled: boolean;
	logToDailyNote: boolean;
	/**
	 * Create today's daily note when a block ends and it does not exist yet.
	 * Off by default: the line goes to "Kiri focus log.md" instead, so Kiri never
	 * creates a second "today" note before a sync service brings the real one.
	 */
	createDailyNote: boolean;
	logHeading: string;
	taskCounter: boolean;
	/** Add the block's minutes to a [spent:: ...] field on the task line. */
	writeSpent: boolean;
	askMarkDone: boolean;
	/** Keep the Today list after midnight instead of starting empty each day. */
	keepToday: boolean;
}

export const DEFAULT_SETTINGS: KiriSettings = {
	focusMinutes: 25,
	breaksEnabled: true,
	breakMinutes: null,
	breaks: { short: 5, medium: 10, long: 15 },
	autoStartNext: false,
	autoStartBreak: true,
	longBreakEnabled: true,
	longBreakMinutes: 15,
	longBreakEvery: 4,
	chime: true,
	chimeStyle: 'bell',
	sound: 'off',
	volume: 50,
	binaural: 'off',
	binauralVolume: 30,
	syncEnabled: true,
	logToDailyNote: true,
	createDailyNote: false,
	logHeading: '## Focus log',
	taskCounter: false,
	writeSpent: false,
	askMarkDone: false,
	keepToday: false,
};

/** Merge saved data over the defaults, ignoring anything malformed. */
export function mergeSettings(saved: unknown): KiriSettings {
	const s: KiriSettings = { ...DEFAULT_SETTINGS, breaks: { ...DEFAULT_SETTINGS.breaks } };
	if (!saved || typeof saved !== 'object') return s;
	const d = saved as Partial<Record<keyof KiriSettings, unknown>>;
	const num = (v: unknown, min: number, max: number, fallback: number): number =>
		typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
	const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

	s.focusMinutes = num(d.focusMinutes, 5, 120, s.focusMinutes);
	s.breaksEnabled = bool(d.breaksEnabled, s.breaksEnabled);
	s.breakMinutes = typeof d.breakMinutes === 'number' && Number.isFinite(d.breakMinutes) ? num(d.breakMinutes, 1, 60, 5) : null;
	if (d.breaks && typeof d.breaks === 'object') {
		const b = d.breaks as Partial<Record<keyof BreakLengths, unknown>>;
		s.breaks = {
			short: num(b.short, 1, 60, s.breaks.short),
			medium: num(b.medium, 1, 60, s.breaks.medium),
			long: num(b.long, 1, 60, s.breaks.long),
		};
	}
	s.autoStartNext = bool(d.autoStartNext, s.autoStartNext);
	s.autoStartBreak = bool(d.autoStartBreak, s.autoStartBreak);
	s.longBreakEnabled = bool(d.longBreakEnabled, s.longBreakEnabled);
	s.longBreakMinutes = num(d.longBreakMinutes, 1, 60, s.longBreakMinutes);
	s.longBreakEvery = num(d.longBreakEvery, 2, 12, s.longBreakEvery);
	s.chime = bool(d.chime, s.chime);
	if (typeof d.chimeStyle === 'string' && d.chimeStyle in CHIME_LABELS) s.chimeStyle = d.chimeStyle as ChimeStyle;
	if (typeof d.sound === 'string' && (d.sound in SOUND_LABELS || isKiriSound(d.sound))) s.sound = d.sound as SoundChoice;
	s.volume = num(d.volume, 0, 100, s.volume);
	if (isBeatKey(d.binaural)) s.binaural = d.binaural;
	s.binauralVolume = num(d.binauralVolume, 0, 100, s.binauralVolume);
	s.syncEnabled = bool(d.syncEnabled, s.syncEnabled);
	s.logToDailyNote = bool(d.logToDailyNote, s.logToDailyNote);
	s.createDailyNote = bool(d.createDailyNote, s.createDailyNote);
	if (typeof d.logHeading === 'string' && d.logHeading.trim().length > 0) s.logHeading = d.logHeading;
	s.taskCounter = bool(d.taskCounter, s.taskCounter);
	s.writeSpent = bool(d.writeSpent, s.writeSpent);
	s.askMarkDone = bool(d.askMarkDone, s.askMarkDone);
	s.keepToday = bool(d.keepToday, s.keepToday);
	return s;
}

export function isKiriSound(value: string): value is `kiri:${string}` {
	return value.startsWith('kiri:') && isSafeSoundKey(value.slice(5));
}
