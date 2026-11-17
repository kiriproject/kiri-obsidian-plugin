/** The parts of Obsidian's DataAdapter the cache needs. */
export interface BinaryStore {
	exists(path: string): Promise<boolean>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ size: number } | null>;
}

/** Largest sound file accepted (bytes). Kiri's recordings are about 15 to 25 MB. */
export const MAX_SOUND_BYTES = 80 * 1024 * 1024;

export function isSafeSoundKey(key: string): boolean {
	return /^[a-z0-9_-]{1,40}$/i.test(key);
}

/**
 * Where a sound can be played from: a file in the plugin folder (played by
 * path, never read into memory), or, when it could not be saved, the
 * downloaded bytes.
 */
export type SoundSource = { kind: 'file'; path: string } | { kind: 'data'; data: ArrayBuffer };

export interface CacheSize {
	files: number;
	bytes: number;
}

/**
 * Keeps downloaded Kiri sounds in the plugin's own folder, so each file is
 * fetched once, the first time it is played. Two requests for the same sound
 * share one download.
 */
export class SoundCache {
	private readonly inFlight = new Map<string, Promise<SoundSource>>();

	constructor(
		private readonly store: BinaryStore,
		/** For example `.obsidian/plugins/kiri-focus-timer/sounds`. */
		readonly dir: string,
		private readonly download: (key: string) => Promise<ArrayBuffer>,
	) {}

	pathFor(key: string): string {
		if (!isSafeSoundKey(key)) throw new Error(`Bad sound key: ${key}`);
		return `${this.dir}/${key}.mp3`;
	}

	async has(key: string): Promise<boolean> {
		return isSafeSoundKey(key) && this.store.exists(this.pathFor(key));
	}

	/** The cached file, downloading it first if needed. */
	ensure(key: string): Promise<SoundSource> {
		const running = this.inFlight.get(key);
		if (running) return running;
		const job = this.fetchOnce(key).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, job);
		return job;
	}

	/** Number and total size of the downloaded sounds. */
	async size(): Promise<CacheSize> {
		if (!(await this.store.exists(this.dir))) return { files: 0, bytes: 0 };
		const { files } = await this.store.list(this.dir);
		let bytes = 0;
		let count = 0;
		for (const file of files) {
			if (!file.endsWith('.mp3')) continue;
			const stat = await this.store.stat(file);
			bytes += stat?.size ?? 0;
			count++;
		}
		return { files: count, bytes };
	}

	/** Delete every downloaded sound. */
	async clear(): Promise<void> {
		if (await this.store.exists(this.dir)) await this.store.rmdir(this.dir, true);
	}

	private async fetchOnce(key: string): Promise<SoundSource> {
		const path = this.pathFor(key);
		if (await this.store.exists(path)) return { kind: 'file', path };
		const data = await this.download(key);
		if (data.byteLength === 0 || data.byteLength > MAX_SOUND_BYTES) throw new Error('The sound file looks wrong.');
		// Written under another name first, so a half-written file is never taken for the sound.
		const part = `${path}.part`;
		try {
			if (!(await this.store.exists(this.dir))) await this.store.mkdir(this.dir);
			await this.store.writeBinary(part, data);
			await this.store.rename(part, path);
			return { kind: 'file', path };
		} catch {
			try {
				if (await this.store.exists(part)) await this.store.remove(part);
			} catch {
				// Nothing more to tidy.
			}
			// Could not save it; play it from memory this time and try saving next time.
			return { kind: 'data', data };
		}
	}
}

/** `24.1 MB`. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
