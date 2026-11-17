import { ApiError, type FocusSessionBody, roundKiris, type SessionSaved } from './api';

/** Most blocks kept while offline; the oldest are dropped first. */
export const MAX_QUEUE = 200;
/** A block that failed this many times is dropped. */
export const MAX_ATTEMPTS = 20;
export const MAX_INTENT = 200;

export interface QueueItem {
	body: FocusSessionBody;
	attempts: number;
	/**
	 * The connection the block was recorded under. Blocks are only ever sent
	 * with that connection's token, so one account's blocks never reach another.
	 */
	connectionId?: string;
}

export interface BlockInfo {
	id: string;
	startedAt: number;
	durationSeconds: number;
	/** Settings value: 'off', a local noise ('brown') or a Kiri sound ('kiri:rain'). */
	sound: string;
	/** Beat key or 'off'. */
	binaural: string;
	intent: string;
}

/** Local noises use the same ids as the Kiri site. */
const LOCAL_AMBIENT: Record<string, string> = { brown: 'brownnoise', pink: 'pinknoise', white: 'whitenoise' };

export function buildSessionBody(block: BlockInfo): FocusSessionBody {
	let ambient = '';
	if (block.sound.startsWith('kiri:')) ambient = block.sound.slice(5);
	else ambient = LOCAL_AMBIENT[block.sound] ?? '';
	return {
		client_block_id: block.id,
		started_at: new Date(block.startedAt).toISOString(),
		duration_seconds: Math.round(block.durationSeconds),
		ambient,
		binaural: block.binaural === 'off' ? '' : block.binaural,
		intent: truncate(block.intent.replace(/\s+/g, ' ').trim(), MAX_INTENT),
	};
}

/** Cut to at most `max` characters without splitting an emoji. */
export function truncate(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : chars.slice(0, max).join('');
}

export function enqueue(queue: readonly QueueItem[], body: FocusSessionBody, connectionId?: string): QueueItem[] {
	if (queue.some((q) => q.body.client_block_id === body.client_block_id)) return [...queue];
	const item: QueueItem = connectionId ? { body, attempts: 0, connectionId } : { body, attempts: 0 };
	return [...queue, item].slice(-MAX_QUEUE);
}

export interface FlushResult {
	remaining: QueueItem[];
	sent: number;
	dropped: number;
	unauthorized: boolean;
	/** Kiris the sent blocks earned (repeats of blocks the server already had count 0). */
	kirisEarned: number;
}

/**
 * Send queued blocks in order. Stops at the first failure worth retrying
 * (offline, server trouble, rate limit) and keeps the rest for later. Blocks
 * the server rejects for good (any other 4xx, such as a 400 for a block that
 * is too old) are dropped, so one bad block never holds back the queue. The server treats repeats of the same
 * client_block_id as one block, so sending twice is safe.
 */
export async function flushQueue(
	queue: readonly QueueItem[],
	send: (body: FocusSessionBody) => Promise<SessionSaved | void>,
): Promise<FlushResult> {
	const remaining = [...queue];
	let sent = 0;
	let dropped = 0;
	let kirisEarned = 0;
	while (remaining.length > 0) {
		const item = remaining[0];
		if (!item) break;
		try {
			const saved = await send(item.body);
			remaining.shift();
			sent++;
			if (saved) kirisEarned = roundKiris(kirisEarned + saved.kirisEarned);
		} catch (err) {
			const status = err instanceof ApiError ? err.status : 0;
			if (status === 401) return { remaining, sent, dropped, unauthorized: true, kirisEarned };
			// Rate limited: try later without counting it as a failure.
			if (status === 429) break;
			const retryable = !(err instanceof ApiError) || err.retryable;
			if (retryable) {
				const attempts = item.attempts + 1;
				if (attempts >= MAX_ATTEMPTS) {
					remaining.shift();
					dropped++;
					continue;
				}
				remaining[0] = { ...item, attempts };
				break;
			}
			remaining.shift();
			dropped++;
		}
	}
	return { remaining, sent, dropped, unauthorized: false, kirisEarned };
}

/** Read the saved queue, skipping anything malformed. */
export function parseQueue(value: unknown): QueueItem[] {
	if (!Array.isArray(value)) return [];
	const out: QueueItem[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const item = raw as { body?: Partial<FocusSessionBody>; attempts?: unknown; connectionId?: unknown };
		const b = item.body;
		if (!b || typeof b.client_block_id !== 'string' || typeof b.started_at !== 'string' || typeof b.duration_seconds !== 'number') continue;
		out.push({
			body: {
				client_block_id: b.client_block_id,
				started_at: b.started_at,
				duration_seconds: b.duration_seconds,
				ambient: typeof b.ambient === 'string' ? b.ambient : '',
				binaural: typeof b.binaural === 'string' ? b.binaural : '',
				intent: typeof b.intent === 'string' ? b.intent : '',
			},
			attempts: typeof item.attempts === 'number' ? item.attempts : 0,
			...(typeof item.connectionId === 'string' && item.connectionId ? { connectionId: item.connectionId } : {}),
		});
	}
	return out.slice(-MAX_QUEUE);
}

/** A random UUID v4 for client_block_id. */
export function newBlockId(): string {
	const c = crypto;
	if (typeof c?.randomUUID === 'function') return c.randomUUID();
	const bytes = new Uint8Array(16);
	c.getRandomValues(bytes);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
