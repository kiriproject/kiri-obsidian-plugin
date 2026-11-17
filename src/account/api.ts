import { requestUrl } from 'obsidian';

/** The Kiri API. Change only in code or tests. */
export const KIRI_API_BASE = 'https://api.project-kiri.com';
export const PRICING_URL = 'https://project-kiri.com/pricing';

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST' | 'DELETE';
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	/** Parsed JSON body; throws when the body is not JSON. */
	json: () => unknown;
	arrayBuffer: () => ArrayBuffer;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** All network calls go through Obsidian's requestUrl (no CORS limits, works on mobile). */
export const obsidianHttp: HttpFn = async (req) => {
	const res = await requestUrl({ ...req, contentType: req.body ? 'application/json' : undefined, throw: false });
	return { status: res.status, json: () => res.json as unknown, arrayBuffer: () => res.arrayBuffer };
};

/** status 0 means the request never got an answer (offline, DNS, timeout). */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ApiError';
	}

	/** Worth trying again later: offline, server trouble, rate limits. */
	get retryable(): boolean {
		return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

export interface AccountSummary {
	name: string;
	emailHint: string;
}

export interface RemoteSound {
	key: string;
	label: string;
	available: boolean;
}

export type Plan = 'free' | 'trial' | 'paid';

/** Which binaural beats the account may use: none, only Alpha, or all of them. */
export type BinauralAccess = 'none' | 'alpha' | 'full';

export function parseBinauralAccess(value: unknown): BinauralAccess {
	return value === 'full' || value === 'alpha' ? value : 'none';
}

export interface MeResponse {
	account: AccountSummary;
	plan: Plan | null;
	trialEndsAt: string | null;
	sounds: RemoteSound[];
	binaural: BinauralAccess;
	/** All kiris the account has earned; null when the server did not send a usable number. */
	kirisTotal: number | null;
}

/** What the server said about a saved focus block. */
export interface SessionSaved {
	/** Kiris this save added: 0 for a repeat of a block the server already had. */
	kirisEarned: number;
}

/**
 * The account's kiri total: a whole number (the server rounds the sum down).
 * A fraction is rounded down too; anything else (missing, negative, a string) is null.
 */
export function parseKiriCount(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
	return Math.floor(value);
}

/**
 * Kiris earned by a focus-session save; a number with up to 2 decimals (0.4 for
 * 10 minutes, 1 for 25). Only a 201 (a new block) counts: a 200 is a repeat of
 * a block the server already saved, and its kiris were counted then.
 */
export function parseKirisEarned(status: number, body: unknown): number {
	if (status !== 201) return 0;
	const value = asObject(body).kiris_earned;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return 0;
	return roundKiris(value);
}

/** Round to 2 decimals, so sums of 0.1 + 0.2 stay tidy. */
export function roundKiris(n: number): number {
	return Math.round(n * 100) / 100;
}

export interface DeviceStart {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

export type TokenPoll =
	| { kind: 'pending' }
	| { kind: 'slow_down' }
	| { kind: 'denied' }
	| { kind: 'expired' }
	| { kind: 'ok'; token: string; account: AccountSummary };

export interface FocusSessionBody {
	client_block_id: string;
	started_at: string;
	duration_seconds: number;
	ambient: string;
	binaural: string;
	intent: string;
}

export class KiriApi {
	constructor(
		private readonly http: HttpFn = obsidianHttp,
		private readonly getToken: () => string | null = () => null,
		/** Called on any 401 from an endpoint that used the token. */
		private readonly onUnauthorized: () => void = () => {},
		readonly base: string = KIRI_API_BASE,
	) {}

	async startDevice(deviceName: string): Promise<DeviceStart> {
		const body = await this.json('POST', '/api/device/start', { client: 'obsidian', device_name: deviceName.trim().slice(0, 60) }, false);
		const o = asObject(body);
		const deviceCode = str(o.device_code);
		const userCode = str(o.user_code);
		const verificationUrl = str(o.verification_url);
		if (!deviceCode || !userCode || !verificationUrl.startsWith('https://')) {
			throw new ApiError(200, 'bad_response', 'Unexpected answer from Kiri.');
		}
		return {
			deviceCode,
			userCode,
			verificationUrl,
			intervalSeconds: positive(o.interval, 5),
			expiresInSeconds: positive(o.expires_in, 600),
		};
	}

	async pollToken(deviceCode: string): Promise<TokenPoll> {
		try {
			const o = asObject(await this.json('POST', '/api/device/token', { device_code: deviceCode }, false));
			const token = str(o.access_token);
			if (!token) throw new ApiError(200, 'bad_response', 'Unexpected answer from Kiri.');
			return { kind: 'ok', token, account: parseAccount(o.account) };
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			if (err.code === 'authorization_pending') return { kind: 'pending' };
			if (err.code === 'slow_down' || err.status === 429) return { kind: 'slow_down' };
			if (err.code === 'access_denied') return { kind: 'denied' };
			if (err.code === 'expired_token') return { kind: 'expired' };
			throw err;
		}
	}

	async me(): Promise<MeResponse> {
		return parseMe(await this.json('GET', '/api/device/me', undefined, true));
	}

	/** The audio file for a sound (audio/mpeg). */
	async sound(key: string): Promise<ArrayBuffer> {
		const res = await this.send('GET', `/api/device/sounds/${encodeURIComponent(key)}`, undefined, true);
		return res.arrayBuffer();
	}

	async postFocusSession(body: FocusSessionBody): Promise<SessionSaved> {
		const res = await this.send('POST', '/api/device/focus-sessions', body, true);
		let parsed: unknown = null;
		try {
			parsed = res.json();
		} catch {
			// Saved, but the answer had no readable body: count nothing.
		}
		return { kirisEarned: parseKirisEarned(res.status, parsed) };
	}

	async revoke(): Promise<void> {
		await this.send('DELETE', '/api/device/token', undefined, true);
	}

	private async json(method: HttpRequest['method'], path: string, body: unknown, auth: boolean): Promise<unknown> {
		const res = await this.send(method, path, body, auth);
		try {
			return res.json();
		} catch {
			throw new ApiError(res.status, 'bad_response', 'Unexpected answer from Kiri.');
		}
	}

	private async send(method: HttpRequest['method'], path: string, body: unknown, auth: boolean): Promise<HttpResponse> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (auth) {
			const token = this.getToken();
			if (!token) throw new ApiError(401, 'not_connected', 'Not connected to a Kiri account.');
			headers.Authorization = `Bearer ${token}`;
		}
		let res: HttpResponse;
		try {
			res = await this.http({
				url: `${this.base}${path}`,
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch {
			throw new ApiError(0, 'network', 'Kiri could not be reached. Check your connection.');
		}
		if (res.status >= 200 && res.status < 300) return res;
		let code = `http_${res.status}`;
		let message = `Kiri answered with an error (${res.status}).`;
		try {
			const o = asObject(res.json());
			if (str(o.error)) code = str(o.error);
			if (str(o.message)) message = str(o.message);
		} catch {
			// Not JSON; keep the generic message.
		}
		if (auth && res.status === 401) this.onUnauthorized();
		throw new ApiError(res.status, code, message);
	}
}

/** Read /api/device/me defensively: unknown or missing fields get safe defaults. */
export function parseMe(body: unknown): MeResponse {
	const o = asObject(body);
	const plan = o.plan === 'free' || o.plan === 'trial' || o.plan === 'paid' ? o.plan : null;
	const sounds: RemoteSound[] = [];
	if (Array.isArray(o.sounds)) {
		for (const item of o.sounds) {
			const s = asObject(item);
			const key = str(s.key);
			if (!/^[a-z0-9_-]{1,40}$/i.test(key)) continue;
			sounds.push({ key, label: str(s.label) || key, available: s.available === true });
		}
	}
	return {
		account: parseAccount(o.account),
		plan,
		trialEndsAt: str(o.trial_ends_at) || null,
		sounds,
		binaural: parseBinauralAccess(o.binaural),
		kirisTotal: parseKiriCount(o.kiris_total),
	};
}

/** The account total, a whole number: "1 kiri", "123 kiris". */
export function formatKiris(n: number): string {
	return n === 1 ? '1 kiri' : `${n} kiris`;
}

/**
 * Kiris just earned, with at most one decimal and no trailing zeros:
 * "0.4 kiri", "1 kiri", "1.5 kiris", "2 kiris". Empty when it rounds to 0.
 */
export function formatEarnedKiris(n: number): string {
	const rounded = Math.round(n * 10) / 10;
	if (rounded <= 0) return '';
	return `${String(rounded)} ${rounded <= 1 ? 'kiri' : 'kiris'}`;
}

function parseAccount(value: unknown): AccountSummary {
	const a = asObject(value);
	return { name: str(a.name).slice(0, 100), emailHint: str(a.email_hint).slice(0, 100) };
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function positive(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
