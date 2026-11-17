/**
 * Noise generators. Pure functions that fill sample arrays, so they can be tested
 * without an audio device. The audio player turns the result into a looping buffer.
 */

export type NoiseKind = 'brown' | 'pink' | 'white';

export type RandomFn = () => number;

/** Small seeded generator (mulberry32) for repeatable tests. */
export function seededRandom(seed: number): RandomFn {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function generateNoise(kind: NoiseKind, length: number, random: RandomFn = Math.random): Float32Array {
	const out = new Float32Array(length);
	const white = (): number => random() * 2 - 1;

	if (kind === 'white') {
		for (let i = 0; i < length; i++) out[i] = white();
	} else if (kind === 'pink') {
		// Paul Kellet's refined pink noise filter.
		let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
		for (let i = 0; i < length; i++) {
			const w = white();
			b0 = 0.99886 * b0 + w * 0.0555179;
			b1 = 0.99332 * b1 + w * 0.0750759;
			b2 = 0.969 * b2 + w * 0.153852;
			b3 = 0.8665 * b3 + w * 0.3104856;
			b4 = 0.55 * b4 + w * 0.5329522;
			b5 = -0.7616 * b5 - w * 0.016898;
			out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
			b6 = w * 0.115926;
		}
	} else {
		// Leaky integrator over white noise.
		let last = 0;
		for (let i = 0; i < length; i++) {
			last = (last + 0.02 * white()) / 1.02;
			out[i] = last;
		}
	}
	return normalize(out, 0.5);
}

/** Scale so the loudest sample has the given peak. Also removes any DC offset. */
export function normalize(samples: Float32Array, peak: number): Float32Array {
	let mean = 0;
	for (let i = 0; i < samples.length; i++) mean += samples[i] ?? 0;
	mean /= samples.length || 1;
	let max = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = (samples[i] ?? 0) - mean;
		samples[i] = v;
		if (Math.abs(v) > max) max = Math.abs(v);
	}
	if (max > 0) {
		const k = peak / max;
		for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) * k;
	}
	return samples;
}

/**
 * Make a buffer that loops without a click.
 * Generates `length + fade` samples, then blends the extra tail into the start
 * with an equal-power crossfade. The last sample of the loop then flows straight
 * into the first one.
 */
export function makeSeamlessLoop(
	kind: NoiseKind,
	length: number,
	fade: number,
	random: RandomFn = Math.random,
): Float32Array {
	return crossfadeLoop(generateNoise(kind, length + fade, random), fade);
}

/**
 * Turn any recording into a click-free loop: the last `fade` samples are blended
 * into the first ones with an equal-power crossfade, and the result is `fade`
 * samples shorter. When it loops, the end runs straight into the start.
 */
export function crossfadeLoop(raw: Float32Array, fade: number): Float32Array {
	const f = Math.max(0, Math.min(Math.floor(fade), Math.floor(raw.length / 2)));
	const length = raw.length - f;
	const out = raw.slice(0, length);
	for (let i = 0; i < f; i++) {
		const t = i / f;
		const fadeIn = Math.sin((t * Math.PI) / 2);
		const fadeOut = Math.cos((t * Math.PI) / 2);
		out[i] = (raw[i] ?? 0) * fadeIn + (raw[length + i] ?? 0) * fadeOut;
	}
	return out;
}
