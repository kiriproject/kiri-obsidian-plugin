import { describe, expect, it } from 'vitest';
import { generateNoise, makeSeamlessLoop, seededRandom } from '../src/audio/noiseGen';

describe('noise generation', () => {
	for (const kind of ['brown', 'pink', 'white'] as const) {
		it(`${kind} noise stays within the target peak and has no DC offset`, () => {
			const s = generateNoise(kind, 48_000, seededRandom(1));
			let max = 0;
			let sum = 0;
			for (const v of s) {
				max = Math.max(max, Math.abs(v));
				sum += v;
			}
			expect(max).toBeCloseTo(0.5, 5);
			expect(Math.abs(sum / s.length)).toBeLessThan(1e-4);
		});

		it(`${kind} loop has no jump at the seam`, () => {
			const loop = makeSeamlessLoop(kind, 48_000, 2_400, seededRandom(7));
			const seam = Math.abs((loop[0] ?? 0) - (loop[loop.length - 1] ?? 0));
			// Typical step between neighbouring samples in the body of the buffer.
			let total = 0;
			for (let i = 1; i < loop.length; i++) total += Math.abs((loop[i] ?? 0) - (loop[i - 1] ?? 0));
			const typical = total / (loop.length - 1);
			expect(seam).toBeLessThan(typical * 6 + 1e-6);
		});
	}

	it('brown noise is smoother than white noise', () => {
		const step = (s: Float32Array): number => {
			let t = 0;
			for (let i = 1; i < s.length; i++) t += Math.abs((s[i] ?? 0) - (s[i - 1] ?? 0));
			return t / s.length;
		};
		const brown = generateNoise('brown', 48_000, seededRandom(3));
		const white = generateNoise('white', 48_000, seededRandom(3));
		expect(step(brown)).toBeLessThan(step(white) / 5);
	});
});
