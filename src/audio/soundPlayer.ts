import { type BeatKey, binauralFrequencies, binauralGain } from './binaural';
import { makeSeamlessLoop, type NoiseKind } from './noiseGen';

const LOOP_SECONDS = 8;
const LOOP_FADE_SECONDS = 0.5;
/** Steps of a volume fade on an audio element that is not routed through Web Audio. */
const ELEMENT_RAMP_STEP_MS = 50;

/**
 * One <audio> element per Kiri recording, kept for the session so pausing and
 * resuming never loads the file again. The element streams the file from
 * disk; it is never decoded into memory as a whole.
 */
interface Recording {
	src: string;
	el: HTMLAudioElement;
	/** Set when the element plays through Web Audio (same-origin sources): fades use this gain. */
	graph: { node: MediaElementAudioSourceNode; gain: GainNode } | null;
	/** Fade level 0..1 when the element's own volume is used instead. */
	level: number;
	ramp: number | null;
	pauseTimer: number | null;
}

interface Voice {
	/** A noise kind ('brown') or a recording id ('kiri:rain'). */
	id: string;
	/** Noise: the buffer source and its gain. */
	gain?: GainNode;
	source?: AudioBufferSourceNode;
	recording?: Recording;
}

/** play() on the audio element was refused (autoplay rules, unsupported file). */
export class PlaybackRefusedError extends Error {
	constructor() {
		super('The sound could not start.');
		this.name = 'PlaybackRefusedError';
	}
}

/**
 * Web Audio only hears an audio element whose source is same-origin; any other
 * source plays as silence. Object URLs are always same-origin. Obsidian's
 * resource paths are same-origin on mobile (capacitor://localhost, http://localhost)
 * but not on desktop (app://<id>/... against app://obsidian.md), so desktop
 * uses the element's own volume.
 */
export function canRouteThroughWebAudio(src: string, pageUrl: string): boolean {
	if (src.startsWith('blob:')) return true;
	try {
		const page = new URL(pageUrl);
		const url = new URL(src, page);
		return url.protocol === page.protocol && url.host === page.host;
	} catch {
		return false;
	}
}

interface BinauralVoice {
	beat: BeatKey;
	gain: GainNode;
	oscillators: OscillatorNode[];
	merger: ChannelMergerNode;
}

/**
 * Plays sound with Web Audio: noise made on the device, Kiri recordings the
 * user downloaded, and binaural tones. Every start, stop and switch is a
 * gain ramp, so there are no clicks.
 */
export class SoundPlayer {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private voice: Voice | null = null;
	private binaural: BinauralVoice | null = null;
	private buffers = new Map<NoiseKind, AudioBuffer>();
	private recordings = new Map<string, Recording>();
	private volume = 0.5;
	private binauralVolume = 0.3;
	/** Bumped on every play or stop, so a slow load never starts a sound that is no longer wanted. */
	private generation = 0;
	/** Set by dispose(): from then on nothing makes a sound or opens an audio device again. */
	private disposed = false;

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** 0..1 from the slider. Uses a squared curve so the low end is usable. */
	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
		if (this.ctx && this.master) {
			this.master.gain.setTargetAtTime(this.volume * this.volume, this.ctx.currentTime, 0.05);
		}
		for (const rec of this.recordings.values()) if (!rec.graph) this.applyElementVolume(rec);
	}

	get playingId(): string | null {
		return this.voice?.id ?? null;
	}

	/** Start (or switch to) a noise with a fade-in. */
	play(kind: NoiseKind, fadeSeconds = 1.5): void {
		const ctx = this.ensureContext();
		if (!ctx) return;
		if (this.voice?.id === kind) return;
		this.stop(Math.min(fadeSeconds, 0.8));
		this.startBuffer(ctx, kind, this.bufferFor(ctx, kind), fadeSeconds);
	}

	/**
	 * Start (or switch to) a downloaded recording, looping, from `src`: a
	 * resource path of the cached file or an object URL. Throws
	 * PlaybackRefusedError when the element refuses to play.
	 */
	async playRecording(id: string, src: string, fadeSeconds = 1.5): Promise<void> {
		if (this.disposed) return;
		const ctx = this.ensureContext();
		if (this.voice?.id === id) return;
		this.stop(Math.min(fadeSeconds, 0.8));
		const generation = this.generation;

		let rec = this.recordings.get(id);
		if (rec && rec.src !== src) {
			releaseRecording(rec);
			this.recordings.delete(id);
			rec = undefined;
		}
		if (!rec) {
			rec = this.createRecording(ctx, src);
			this.recordings.set(id, rec);
		}
		if (rec.pauseTimer !== null) {
			window.clearTimeout(rec.pauseTimer);
			rec.pauseTimer = null;
		}
		this.voice = { id, recording: rec };
		this.fadeRecording(rec, 1, fadeSeconds);
		try {
			await rec.el.play();
			if (this.disposed) releaseRecording(rec);
		} catch {
			// Stopped or switched meanwhile: that pause is what interrupted play().
			if (generation !== this.generation) return;
			if (this.voice?.recording === rec) this.voice = null;
			this.fadeRecording(rec, 0, 0);
			rec.el.pause();
			throw new PlaybackRefusedError();
		}
	}

	/** Fade the current sound out and stop it. */
	stop(fadeSeconds = 1): void {
		this.generation++;
		const voice = this.voice;
		this.voice = null;
		if (!voice) return;
		if (voice.recording) {
			const rec = voice.recording;
			this.fadeRecording(rec, 0, fadeSeconds);
			if (rec.pauseTimer !== null) window.clearTimeout(rec.pauseTimer);
			rec.pauseTimer = window.setTimeout(() => {
				rec.pauseTimer = null;
				if (this.voice?.recording !== rec) rec.el.pause();
			}, (fadeSeconds + 0.1) * 1000);
			return;
		}
		const ctx = this.ctx;
		if (!ctx || !voice.gain) return;
		const gain = voice.gain;
		const now = ctx.currentTime;
		const param = gain.gain;
		param.cancelScheduledValues(now);
		param.setValueAtTime(param.value, now);
		param.linearRampToValueAtTime(0, now + fadeSeconds);
		if (voice.source) {
			const source = voice.source;
			source.stop(now + fadeSeconds + 0.05);
			source.onended = () => {
				source.disconnect();
				gain.disconnect();
			};
		}
	}

	/** Start (or switch) binaural tones with a fade-in. */
	startBinaural(beat: BeatKey, fadeSeconds = 2): void {
		const ctx = this.ensureContext();
		if (!ctx) return;
		if (this.binaural?.beat === beat) return;
		this.stopBinaural(Math.min(fadeSeconds, 0.8));
		const { left, right } = binauralFrequencies(beat);
		const merger = ctx.createChannelMerger(2);
		const gain = ctx.createGain();
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(binauralGain(this.binauralVolume * 100), now + fadeSeconds);
		const oscillators = [left, right].map((freq, channel) => {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = freq;
			osc.connect(merger, 0, channel);
			osc.start(now);
			return osc;
		});
		merger.connect(gain);
		gain.connect(ctx.destination);
		this.binaural = { beat, gain, oscillators, merger };
	}

	stopBinaural(fadeSeconds = 1): void {
		const voice = this.binaural;
		const ctx = this.ctx;
		this.binaural = null;
		if (!voice || !ctx) return;
		const now = ctx.currentTime;
		const param = voice.gain.gain;
		param.cancelScheduledValues(now);
		param.setValueAtTime(param.value, now);
		param.linearRampToValueAtTime(0, now + fadeSeconds);
		voice.oscillators.forEach((osc, i) => {
			osc.stop(now + fadeSeconds + 0.05);
			if (i === 0) {
				osc.onended = () => {
					voice.oscillators.forEach((o) => o.disconnect());
					voice.merger.disconnect();
					voice.gain.disconnect();
				};
			}
		});
	}

	/** 0..1 from the slider; the tones never get louder than MAX_BINAURAL_GAIN. */
	setBinauralVolume(volume: number): void {
		this.binauralVolume = Math.min(1, Math.max(0, volume));
		if (this.ctx && this.binaural) {
			this.binaural.gain.gain.setTargetAtTime(binauralGain(this.binauralVolume * 100), this.ctx.currentTime, 0.05);
		}
	}

	/**
	 * Stop and release every recording's audio element (after disconnecting or
	 * deleting the downloaded sounds), so no file stays open.
	 */
	forgetRecordings(): void {
		if (this.voice?.recording) {
			this.generation++;
			this.voice = null;
		}
		for (const rec of this.recordings.values()) releaseRecording(rec);
		this.recordings.clear();
	}

	/**
	 * A chime made from sine waves. 'bell' is two notes; 'soft' is one low,
	 * quieter note with a slow start and a long fade.
	 */
	chime(style: 'bell' | 'soft' = 'bell'): void {
		const ctx = this.ensureContext();
		if (!ctx) return;
		const start = ctx.currentTime + 0.05;
		if (style === 'soft') {
			this.bell(ctx, 523.25, start, 0.07, 0.25, 3.5);
			return;
		}
		this.bell(ctx, 659.25, start, 0.16);
		this.bell(ctx, 880, start + 0.35, 0.13);
	}

	/** Stop everything and release the audio device. */
	dispose(): void {
		this.disposed = true;
		this.generation++;
		if (this.voice) {
			const { source, gain } = this.voice;
			if (source) {
				try {
					source.stop();
				} catch {
					// Already stopped.
				}
				source.disconnect();
			}
			gain?.disconnect();
			this.voice = null;
		}
		for (const rec of this.recordings.values()) releaseRecording(rec);
		this.recordings.clear();
		if (this.binaural) {
			for (const osc of this.binaural.oscillators) {
				try {
					osc.stop();
				} catch {
					// Already stopped.
				}
				osc.disconnect();
			}
			this.binaural.merger.disconnect();
			this.binaural.gain.disconnect();
			this.binaural = null;
		}
		this.buffers.clear();
		const ctx = this.ctx;
		this.ctx = null;
		this.master = null;
		if (ctx && ctx.state !== 'closed') {
			void ctx.close().catch(() => {
				// Nothing else to release.
			});
		}
	}

	private bell(ctx: AudioContext, freq: number, start: number, peak: number, attack = 0.02, decay = 2.4): void {
		const out = ctx.createGain();
		out.gain.setValueAtTime(0.0001, start);
		out.gain.exponentialRampToValueAtTime(peak, start + attack);
		out.gain.exponentialRampToValueAtTime(0.0001, start + decay);
		out.connect(ctx.destination);
		for (const [mult, level] of [
			[1, 1],
			[2, 0.25],
		] as const) {
			const osc = ctx.createOscillator();
			osc.type = 'sine';
			osc.frequency.value = freq * mult;
			const g = ctx.createGain();
			g.gain.value = level;
			osc.connect(g);
			g.connect(out);
			osc.start(start);
			osc.stop(start + decay + 0.1);
			osc.onended = () => {
				osc.disconnect();
				g.disconnect();
				if (mult === 1) out.disconnect();
			};
		}
	}

	private ensureContext(): AudioContext | null {
		if (this.disposed) return null;
		if (!this.ctx) {
			const Ctor = window.AudioContext;
			if (typeof Ctor !== 'function') return null;
			this.ctx = new Ctor();
			this.master = this.ctx.createGain();
			this.master.gain.value = this.volume * this.volume;
			this.master.connect(this.ctx.destination);
		}
		if (this.ctx.state === 'suspended') {
			void this.ctx.resume().catch(() => {
				// Will retry on the next user action.
			});
		}
		return this.ctx;
	}

	private startBuffer(ctx: AudioContext, id: string, buffer: AudioBuffer, fadeSeconds: number): void {
		if (!this.master) return;
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		const gain = ctx.createGain();
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(1, now + fadeSeconds);
		source.connect(gain);
		gain.connect(this.master);
		source.start(now);
		this.voice = { id, source, gain };
	}

	private createRecording(ctx: AudioContext | null, src: string): Recording {
		const el = new Audio();
		el.loop = true;
		el.preload = 'auto';
		el.src = src;
		let graph: Recording['graph'] = null;
		if (ctx && this.master && canRouteThroughWebAudio(src, window.location.href)) {
			const node = ctx.createMediaElementSource(el);
			const gain = ctx.createGain();
			gain.gain.value = 0;
			node.connect(gain);
			gain.connect(this.master);
			graph = { node, gain };
		}
		const rec: Recording = { src, el, graph, level: 0, ramp: null, pauseTimer: null };
		if (!graph) this.applyElementVolume(rec);
		return rec;
	}

	/** Fade a recording to `target` (0..1) over `seconds`. */
	private fadeRecording(rec: Recording, target: number, seconds: number): void {
		if (rec.graph && this.ctx) {
			const param = rec.graph.gain.gain;
			const now = this.ctx.currentTime;
			param.cancelScheduledValues(now);
			param.setValueAtTime(param.value, now);
			param.linearRampToValueAtTime(target, now + Math.max(0.01, seconds));
			return;
		}
		if (rec.ramp !== null) window.clearInterval(rec.ramp);
		rec.ramp = null;
		const steps = Math.max(1, Math.round((seconds * 1000) / ELEMENT_RAMP_STEP_MS));
		if (seconds <= 0) {
			rec.level = target;
			this.applyElementVolume(rec);
			return;
		}
		const from = rec.level;
		let step = 0;
		rec.ramp = window.setInterval(() => {
			step++;
			rec.level = from + ((target - from) * step) / steps;
			this.applyElementVolume(rec);
			if (step >= steps && rec.ramp !== null) {
				window.clearInterval(rec.ramp);
				rec.ramp = null;
			}
		}, ELEMENT_RAMP_STEP_MS);
	}

	/** Element volume = fade level × the squared master volume (Web Audio is not in the path). */
	private applyElementVolume(rec: Recording): void {
		rec.el.volume = Math.min(1, Math.max(0, rec.level * this.volume * this.volume));
	}

	private bufferFor(ctx: AudioContext, kind: NoiseKind): AudioBuffer {
		const cached = this.buffers.get(kind);
		if (cached) return cached;
		const rate = ctx.sampleRate;
		const length = Math.floor(rate * LOOP_SECONDS);
		const fade = Math.floor(rate * LOOP_FADE_SECONDS);
		const buffer = ctx.createBuffer(2, length, rate);
		for (let ch = 0; ch < 2; ch++) {
			buffer.getChannelData(ch).set(makeSeamlessLoop(kind, length, fade));
		}
		this.buffers.set(kind, buffer);
		return buffer;
	}
}

function releaseRecording(rec: Recording): void {
	if (rec.ramp !== null) window.clearInterval(rec.ramp);
	if (rec.pauseTimer !== null) window.clearTimeout(rec.pauseTimer);
	rec.ramp = null;
	rec.pauseTimer = null;
	rec.el.pause();
	rec.el.removeAttribute('src');
	rec.el.load();
	if (rec.graph) {
		rec.graph.node.disconnect();
		rec.graph.gain.disconnect();
	}
}
