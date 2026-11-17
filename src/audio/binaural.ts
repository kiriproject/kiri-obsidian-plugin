/**
 * Binaural beats: two steady sine tones, one in each ear, a few hertz apart.
 * Made on the device with Web Audio. Keys match the Kiri site's beat ids.
 */

export type BeatKey = 'alpha' | 'beta' | 'theta' | 'delta' | 'gamma';
export type BinauralChoice = 'off' | BeatKey;

export const BEATS: Record<BeatKey, { name: string; hz: number }> = {
	alpha: { name: 'Alpha', hz: 10 },
	beta: { name: 'Beta', hz: 18 },
	theta: { name: 'Theta', hz: 6 },
	delta: { name: 'Delta', hz: 2 },
	gamma: { name: 'Gamma', hz: 40 },
};

export const BINAURAL_LABELS: Record<BinauralChoice, string> = {
	off: 'Off',
	alpha: 'Alpha (10 Hz apart)',
	beta: 'Beta (18 Hz apart)',
	theta: 'Theta (6 Hz apart)',
	delta: 'Delta (2 Hz apart)',
	gamma: 'Gamma (40 Hz apart)',
};

/** The lower tone sits near 200 Hz, a soft hum. */
export const CARRIER_HZ = 200;
/** Loudest the tones can get, whatever the slider says. */
export const MAX_BINAURAL_GAIN = 0.12;

export function isBeatKey(value: unknown): value is BeatKey {
	return typeof value === 'string' && value in BEATS;
}

export function binauralFrequencies(beat: BeatKey): { left: number; right: number } {
	const hz = BEATS[beat].hz;
	return { left: CARRIER_HZ - hz / 2, right: CARRIER_HZ + hz / 2 };
}

/** Slider 0..100 to a gain that never goes above MAX_BINAURAL_GAIN. */
export function binauralGain(volume: number): number {
	const v = Math.min(100, Math.max(0, Number.isFinite(volume) ? volume : 0)) / 100;
	return MAX_BINAURAL_GAIN * v * v;
}
