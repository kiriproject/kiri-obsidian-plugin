import { afterEach, describe, expect, it, vi } from 'vitest';
import { binauralFrequencies, binauralGain, isBeatKey, MAX_BINAURAL_GAIN } from '../src/audio/binaural';
import { crossfadeLoop } from '../src/audio/noiseGen';
import { type BinaryStore, formatBytes, SoundCache } from '../src/audio/soundCache';
import { canRouteThroughWebAudio, SoundPlayer } from '../src/audio/soundPlayer';

function memoryStore(): BinaryStore & { files: Map<string, ArrayBuffer>; dirs: Set<string> } {
	const files = new Map<string, ArrayBuffer>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		exists: async (p) => files.has(p) || dirs.has(p),
		writeBinary: async (p, d) => {
			files.set(p, d);
		},
		rename: async (from, to) => {
			const f = files.get(from);
			if (!f) throw new Error('missing');
			files.delete(from);
			files.set(to, f);
		},
		remove: async (p) => {
			files.delete(p);
		},
		mkdir: async (p) => {
			dirs.add(p);
		},
		rmdir: async (p) => {
			dirs.delete(p);
			for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
		},
		list: async (p) => ({ files: [...files.keys()].filter((k) => k.startsWith(`${p}/`)), folders: [] }),
		stat: async (p) => {
			const f = files.get(p);
			return f ? { size: f.byteLength } : null;
		},
	};
}

describe('SoundCache', () => {
	const DIR = '.obsidian/plugins/kiri-focus-timer/sounds';

	it('downloads once on first play, then plays the file by path', async () => {
		const store = memoryStore();
		const download = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
		const cache = new SoundCache(store, DIR, download);
		expect(await cache.has('rain')).toBe(false);
		expect(download).not.toHaveBeenCalled();
		const [a, b] = await Promise.all([cache.ensure('rain'), cache.ensure('rain')]);
		expect(a).toEqual({ kind: 'file', path: `${DIR}/rain.mp3` });
		expect(b).toEqual(a);
		expect(download).toHaveBeenCalledOnce();
		expect([...store.files.keys()]).toEqual([`${DIR}/rain.mp3`]);
		await cache.ensure('rain');
		expect(download).toHaveBeenCalledOnce();
		expect(await cache.has('rain')).toBe(true);
	});

	it('refuses keys that could leave the folder', async () => {
		const cache = new SoundCache(memoryStore(), DIR, async () => new ArrayBuffer(1));
		await expect(cache.ensure('../evil')).rejects.toThrow();
		expect(await cache.has('../evil')).toBe(false);
	});

	it('does not cache an empty download', async () => {
		const store = memoryStore();
		const cache = new SoundCache(store, DIR, async () => new ArrayBuffer(0));
		await expect(cache.ensure('rain')).rejects.toThrow();
		expect(store.files.size).toBe(0);
	});

	it('plays from memory when the file cannot be saved, and leaves no partial file', async () => {
		const store = memoryStore();
		store.rename = async () => {
			throw new Error('disk full');
		};
		const cache = new SoundCache(store, DIR, async () => new ArrayBuffer(4));
		const source = await cache.ensure('rain');
		expect(source.kind).toBe('data');
		expect(source.kind === 'data' ? source.data.byteLength : 0).toBe(4);
		expect(store.files.size).toBe(0);
	});

	it('reports the size of the downloaded sounds and clears them', async () => {
		const store = memoryStore();
		const cache = new SoundCache(store, DIR, async (key) => new ArrayBuffer(key === 'rain' ? 3 * 1024 * 1024 : 1024 * 1024));
		expect(await cache.size()).toEqual({ files: 0, bytes: 0 });
		await cache.ensure('rain');
		await cache.ensure('cafe');
		expect(await cache.size()).toEqual({ files: 2, bytes: 4 * 1024 * 1024 });
		await cache.clear();
		expect(store.files.size).toBe(0);
		expect(await cache.size()).toEqual({ files: 0, bytes: 0 });
	});

	it('formats sizes', () => {
		expect(formatBytes(0)).toBe('0 KB');
		expect(formatBytes(512 * 1024)).toBe('512 KB');
		expect(formatBytes(24.6 * 1024 * 1024)).toBe('24.6 MB');
	});
});

describe('canRouteThroughWebAudio', () => {
	it('routes only same-origin sources through Web Audio', () => {
		// Desktop: resource paths are on another host, which Web Audio would hear as silence.
		expect(canRouteThroughWebAudio('app://8f3a2c/Users/sam/vault/.obsidian/plugins/kiri-focus-timer/sounds/rain.mp3?1731', 'app://obsidian.md/index.html')).toBe(false);
		// iOS and Android: same origin as the app.
		expect(canRouteThroughWebAudio('capacitor://localhost/_capacitor_file_/var/rain.mp3', 'capacitor://localhost/')).toBe(true);
		expect(canRouteThroughWebAudio('http://localhost/_capacitor_file_/storage/rain.mp3', 'http://localhost/')).toBe(true);
		expect(canRouteThroughWebAudio('blob:app://obsidian.md/1234', 'app://obsidian.md/index.html')).toBe(true);
		expect(canRouteThroughWebAudio('::not a url', 'nope')).toBe(false);
	});
});

describe('crossfadeLoop', () => {
	it('blends the tail into the start so the loop point is smooth', () => {
		const raw = new Float32Array(100).map((_, i) => i / 100);
		const out = crossfadeLoop(raw, 10);
		expect(out.length).toBe(90);
		// At the seam the start equals the sample that followed the cut end.
		expect(out[0]).toBeCloseTo(raw[90] ?? 0, 5);
		expect(out[89]).toBeCloseTo(raw[89] ?? 0, 5);
	});

	it('never fades longer than half the recording', () => {
		expect(crossfadeLoop(new Float32Array(10), 50).length).toBe(5);
	});
});

describe('binaural beats', () => {
	it('puts the two tones the beat apart around the carrier', () => {
		const { left, right } = binauralFrequencies('alpha');
		expect(right - left).toBe(10);
		expect(binauralFrequencies('gamma').right - binauralFrequencies('gamma').left).toBe(40);
	});

	it('caps the volume', () => {
		expect(binauralGain(100)).toBe(MAX_BINAURAL_GAIN);
		expect(binauralGain(500)).toBe(MAX_BINAURAL_GAIN);
		expect(binauralGain(0)).toBe(0);
		expect(binauralGain(50)).toBeLessThan(MAX_BINAURAL_GAIN / 2);
		expect(binauralGain(Number.NaN)).toBe(0);
	});

	it('knows the beat keys', () => {
		expect(isBeatKey('theta')).toBe(true);
		expect(isBeatKey('wave')).toBe(false);
		expect(isBeatKey('off')).toBe(false);
	});
});

describe('SoundPlayer after dispose (review 2, code S2)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('never opens an audio device or an audio element again', async () => {
		let contexts = 0;
		let elements = 0;
		vi.stubGlobal('window', {
			AudioContext: class {
				constructor() {
					contexts++;
				}
			},
			location: { href: 'app://obsidian.md/index.html' },
		});
		vi.stubGlobal(
			'Audio',
			class {
				constructor() {
					elements++;
				}
			},
		);
		const player = new SoundPlayer();
		player.dispose();
		expect(player.isDisposed).toBe(true);
		player.chime('bell');
		player.play('brown');
		player.startBinaural('alpha');
		await player.playRecording('kiri:rain', 'app://x/rain.mp3');
		expect(contexts).toBe(0);
		expect(elements).toBe(0);
		expect(player.playingId).toBeNull();
	});
});
