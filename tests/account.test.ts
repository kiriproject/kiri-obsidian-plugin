import { describe, expect, it, vi } from 'vitest';
import { DEVICE_KEY, type DeviceStore, KiriAccount, type SecretStore, secretIdFor } from '../src/account/account';
import { ApiError, formatEarnedKiris, formatKiris, type HttpFn, type HttpRequest, type HttpResponse, KiriApi, parseKiriCount, parseKirisEarned, parseMe } from '../src/account/api';
import { DeviceFlow, type FlowState } from '../src/account/deviceFlow';
import { buildSessionBody, enqueue, flushQueue, MAX_ATTEMPTS, MAX_QUEUE, newBlockId, parseQueue, truncate } from '../src/account/syncQueue';

const BASE = 'https://api.test';

function res(status: number, body?: unknown): HttpResponse {
	return {
		status,
		json: () => {
			if (body === undefined) throw new Error('not json');
			return body;
		},
		arrayBuffer: () => new ArrayBuffer(0),
	};
}

type Handler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** A fake requestUrl: routes "METHOD /path" to handlers and records every call. */
function fakeHttp(routes: Record<string, Handler | Handler[]>): { http: HttpFn; calls: HttpRequest[] } {
	const calls: HttpRequest[] = [];
	const http: HttpFn = async (req) => {
		calls.push(req);
		const key = `${req.method} ${req.url.replace(BASE, '')}`;
		const route = routes[key];
		if (!route) return res(404, { error: 'not_found' });
		const handler = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
		if (!handler) throw new Error('no handler');
		return handler(req);
	};
	return { http, calls };
}

const START = {
	device_code: 'dc_' + 'x'.repeat(43),
	user_code: 'ABCD-EFGH',
	verification_url: 'https://project-kiri.com/connect?code=ABCD-EFGH',
	interval: 5,
	expires_in: 600,
};
const TOKEN = { access_token: 'kdt_secret_token_value', token_type: 'Bearer', account: { name: 'Sam', email_hint: 's***@example.com' } };
const ME = {
	account: { name: 'Sam', email_hint: 's***@example.com' },
	plan: 'free',
	trial_ends_at: null,
	sounds: [
		{ key: 'rain', label: 'Rain', available: true },
		{ key: 'cafe', label: 'Café', available: false },
		{ key: '../etc', label: 'Bad', available: true },
	],
	binaural: 'none',
};

/** A clock that moves forward by exactly the time waited. */
function clock(): { now: () => number; wait: (ms: number) => Promise<void>; waits: number[] } {
	let t = 0;
	const waits: number[] = [];
	return {
		now: () => t,
		wait: async (ms) => {
			waits.push(ms);
			t += ms;
		},
		waits,
	};
}

function flowWith(routes: Record<string, Handler | Handler[]>) {
	const { http, calls } = fakeHttp(routes);
	const c = clock();
	const states: FlowState[] = [];
	const opened: string[] = [];
	const flow = new DeviceFlow({
		api: new KiriApi(http, () => null, () => {}, BASE),
		openUrl: (u) => opened.push(u),
		wait: c.wait,
		now: c.now,
		onChange: (s) => states.push(s),
	});
	return { flow, calls, c, states, opened };
}

describe('KiriApi', () => {
	it('starts the device flow with the contract body', async () => {
		const { http, calls } = fakeHttp({ 'POST /api/device/start': () => res(200, START) });
		const api = new KiriApi(http, () => null, () => {}, BASE);
		const start = await api.startDevice('  Obsidian on this computer  ');
		expect(start).toEqual({
			deviceCode: START.device_code,
			userCode: 'ABCD-EFGH',
			verificationUrl: START.verification_url,
			intervalSeconds: 5,
			expiresInSeconds: 600,
		});
		expect(calls[0]?.url).toBe(`${BASE}/api/device/start`);
		expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ client: 'obsidian', device_name: 'Obsidian on this computer' });
		expect(calls[0]?.headers?.Authorization).toBeUndefined();
	});

	it('cuts the device name to 60 characters', async () => {
		const { http, calls } = fakeHttp({ 'POST /api/device/start': () => res(200, START) });
		await new KiriApi(http, () => null, () => {}, BASE).startDevice('x'.repeat(80));
		expect((JSON.parse(calls[0]?.body ?? '') as { device_name: string }).device_name).toHaveLength(60);
	});

	it('refuses a verification URL that is not https', async () => {
		const { http } = fakeHttp({ 'POST /api/device/start': () => res(200, { ...START, verification_url: 'javascript:alert(1)' }) });
		await expect(new KiriApi(http, () => null, () => {}, BASE).startDevice('x')).rejects.toBeInstanceOf(ApiError);
	});

	it('sends the bearer token and reports 401', async () => {
		const onUnauthorized = vi.fn();
		const { http, calls } = fakeHttp({ 'GET /api/device/me': () => res(401, { error: 'invalid_token', message: 'Revoked' }) });
		const api = new KiriApi(http, () => 'kdt_abc', onUnauthorized, BASE);
		await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
		expect(calls[0]?.headers?.Authorization).toBe('Bearer kdt_abc');
		expect(onUnauthorized).toHaveBeenCalledOnce();
	});

	it('turns network failures into retryable errors', async () => {
		const http: HttpFn = async () => {
			throw new Error('offline');
		};
		const err = await new KiriApi(http, () => 't', () => {}, BASE).me().catch((e: unknown) => e);
		expect(err).toMatchObject({ status: 0, code: 'network', retryable: true });
	});

	it('reads /me defensively', () => {
		const me = parseMe(ME);
		expect(me.plan).toBe('free');
		expect(me.sounds.map((s) => s.key)).toEqual(['rain', 'cafe']);
		expect(me.binaural).toBe('none');
		expect(parseMe({ plan: 'gold', binaural: 'yes' })).toMatchObject({ plan: null, binaural: 'none', sounds: [] });
	});

	it('encodes sound keys in the path', async () => {
		const { http, calls } = fakeHttp({ 'GET /api/device/sounds/rain': () => res(200) });
		await new KiriApi(http, () => 't', () => {}, BASE).sound('rain');
		expect(calls[0]?.url).toBe(`${BASE}/api/device/sounds/rain`);
	});
});

describe('DeviceFlow', () => {
	it('opens the page, polls at the interval and finishes with the token', async () => {
		const { flow, calls, c, states, opened } = flowWith({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': [
				() => res(400, { error: 'authorization_pending' }),
				() => res(400, { error: 'authorization_pending' }),
				() => res(200, TOKEN),
			],
		});
		const result = await flow.run('Obsidian on this computer');
		expect(result).toEqual({ step: 'done', token: TOKEN.access_token, account: { name: 'Sam', emailHint: 's***@example.com' } });
		expect(opened).toEqual([START.verification_url]);
		expect(c.waits).toEqual([5000, 5000, 5000]);
		expect(states.map((s) => s.step)).toEqual(['starting', 'waiting', 'done']);
		expect(states[1]).toMatchObject({ userCode: 'ABCD-EFGH', expiresAt: 600_000 });
		expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ device_code: START.device_code });
	});

	it('adds 5 seconds after slow_down', async () => {
		const { flow, c } = flowWith({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': [() => res(400, { error: 'slow_down' }), () => res(400, { error: 'authorization_pending' }), () => res(200, TOKEN)],
		});
		await flow.run('x');
		expect(c.waits).toEqual([5000, 10000, 10000]);
	});

	it('stops when the user denies', async () => {
		const { flow } = flowWith({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => res(400, { error: 'access_denied' }),
		});
		expect((await flow.run('x')).step).toBe('denied');
	});

	it('stops when the server says the code expired', async () => {
		const { flow } = flowWith({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => res(400, { error: 'expired_token' }),
		});
		expect((await flow.run('x')).step).toBe('expired');
	});

	it('stops by itself once expires_in has passed', async () => {
		const { flow, calls } = flowWith({
			'POST /api/device/start': () => res(200, { ...START, interval: 5, expires_in: 12 }),
			'POST /api/device/token': () => res(400, { error: 'authorization_pending' }),
		});
		expect((await flow.run('x')).step).toBe('expired');
		expect(calls.filter((r) => r.url.endsWith('/token'))).toHaveLength(2);
	});

	it('can be cancelled while waiting, and stops polling', async () => {
		const { http, calls } = fakeHttp({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => res(400, { error: 'authorization_pending' }),
		});
		let release: (() => void) | null = null;
		const flow = new DeviceFlow({
			api: new KiriApi(http, () => null, () => {}, BASE),
			openUrl: () => {},
			wait: () => new Promise<void>((r) => (release = r)),
			now: () => 0,
			onChange: () => {},
		});
		const done = flow.run('x');
		await vi.waitFor(() => expect(flow.state.step).toBe('waiting'));
		flow.cancel();
		expect((await done).step).toBe('cancelled');
		(release as (() => void) | null)?.();
		expect(calls.filter((r) => r.url.endsWith('/token'))).toHaveLength(0);
	});

	it('a poll answered after Cancel and a new Connect does not keep the old loop going (review 2, code N1)', async () => {
		let answerOld: ((r: HttpResponse) => void) | null = null;
		let polls = 0;
		const { http } = fakeHttp({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => {
				polls++;
				if (polls === 1) return new Promise<HttpResponse>((r) => (answerOld = r));
				return res(400, { error: 'authorization_pending' });
			},
		});
		const releases: (() => void)[] = [];
		const flow = new DeviceFlow({
			api: new KiriApi(http, () => null, () => {}, BASE),
			openUrl: () => {},
			wait: () => new Promise<void>((r) => releases.push(r)),
			now: () => 0,
			onChange: () => {},
		});
		const first = flow.run('x');
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		releases.shift()?.();
		await vi.waitFor(() => expect(polls).toBe(1));
		flow.cancel();
		const second = flow.run('x');
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		// The old poll answers now: the old loop must end instead of waiting and polling again.
		(answerOld as ((r: HttpResponse) => void) | null)?.(res(400, { error: 'authorization_pending' }));
		expect((await first).step).not.toBe('done');
		await new Promise((r) => setTimeout(r, 5));
		expect(releases).toHaveLength(1);
		releases.shift()?.();
		await vi.waitFor(() => expect(polls).toBe(2));
		flow.cancel();
		expect((await second).step).toBe('cancelled');
	});

	it('reports start errors with the server message', async () => {
		const { flow } = flowWith({ 'POST /api/device/start': () => res(429, { error: 'rate_limited', message: 'Too many tries.' }) });
		expect(await flow.run('x')).toEqual({ step: 'error', message: 'Too many tries.' });
	});

	it('keeps polling through a short network hiccup', async () => {
		const { flow } = flowWith({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': [() => res(503), () => res(200, TOKEN)],
		});
		expect((await flow.run('x')).step).toBe('done');
	});
});

describe('sync queue', () => {
	const block = {
		id: '11111111-2222-4333-8444-555555555555',
		startedAt: Date.UTC(2026, 10, 15, 10, 0),
		durationSeconds: 1500,
		sound: 'kiri:rain',
		binaural: 'off',
		intent: '  Write   the intro  ',
	};

	it('builds the contract body', () => {
		expect(buildSessionBody(block)).toEqual({
			client_block_id: block.id,
			started_at: '2026-11-15T10:00:00.000Z',
			duration_seconds: 1500,
			ambient: 'rain',
			binaural: '',
			intent: 'Write the intro',
		});
		expect(buildSessionBody({ ...block, sound: 'brown', binaural: 'alpha' })).toMatchObject({ ambient: 'brownnoise', binaural: 'alpha' });
		expect(buildSessionBody({ ...block, sound: 'off' }).ambient).toBe('');
	});

	it('keeps the intent to 200 characters without splitting emoji', () => {
		expect(buildSessionBody({ ...block, intent: 'a'.repeat(300) }).intent).toHaveLength(200);
		expect(truncate('😀😀😀', 2)).toBe('😀😀');
	});

	it('does not queue the same block twice and caps the queue', () => {
		const body = buildSessionBody(block);
		expect(enqueue(enqueue([], body), body)).toHaveLength(1);
		let q = enqueue([], body);
		for (let i = 0; i < MAX_QUEUE + 5; i++) q = enqueue(q, { ...body, client_block_id: String(i) });
		expect(q).toHaveLength(MAX_QUEUE);
		expect(q[q.length - 1]?.body.client_block_id).toBe(String(MAX_QUEUE + 4));
	});

	it('sends in order and stops at the first retryable failure', async () => {
		const body = buildSessionBody(block);
		let q = enqueue([], { ...body, client_block_id: 'a' });
		q = enqueue(q, { ...body, client_block_id: 'b' });
		q = enqueue(q, { ...body, client_block_id: 'c' });
		const sent: string[] = [];
		const result = await flushQueue(q, async (b) => {
			if (b.client_block_id === 'b') throw new ApiError(0, 'network', 'offline');
			sent.push(b.client_block_id);
		});
		expect(sent).toEqual(['a']);
		expect(result.remaining.map((r) => [r.body.client_block_id, r.attempts])).toEqual([
			['b', 1],
			['c', 0],
		]);
	});

	it('drops blocks the server rejects for good, and old failures', async () => {
		const body = buildSessionBody(block);
		const rejected = await flushQueue(enqueue([], body), async () => {
			throw new ApiError(400, 'invalid_duration', 'Too short');
		});
		expect(rejected).toMatchObject({ remaining: [], dropped: 1 });
		const tired = await flushQueue([{ body, attempts: MAX_ATTEMPTS - 1 }], async () => {
			throw new ApiError(503, 'http_503', 'down');
		});
		expect(tired).toMatchObject({ remaining: [], dropped: 1 });
	});

	it('keeps a rate-limited block without counting it as a failure', async () => {
		const body = buildSessionBody(block);
		const result = await flushQueue([{ body, attempts: MAX_ATTEMPTS - 1 }], async () => {
			throw new ApiError(429, 'rate_limited', 'Slow down');
		});
		expect(result).toMatchObject({ dropped: 0, sent: 0 });
		expect(result.remaining).toEqual([{ body, attempts: MAX_ATTEMPTS - 1 }]);
	});

	it('drops a block the server says is too old, and sends the next one', async () => {
		const body = buildSessionBody(block);
		let q = enqueue([], { ...body, client_block_id: 'old' });
		q = enqueue(q, { ...body, client_block_id: 'new' });
		const sent: string[] = [];
		const result = await flushQueue(q, async (b) => {
			if (b.client_block_id === 'old') throw new ApiError(400, 'started_at_too_old', 'Too old');
			sent.push(b.client_block_id);
		});
		expect(sent).toEqual(['new']);
		expect(result).toMatchObject({ remaining: [], dropped: 1, sent: 1 });
	});

	it('stops and keeps everything on 401', async () => {
		const body = buildSessionBody(block);
		const result = await flushQueue(enqueue([], body), async () => {
			throw new ApiError(401, 'invalid_token', 'Revoked');
		});
		expect(result).toMatchObject({ unauthorized: true, sent: 0 });
		expect(result.remaining).toHaveLength(1);
	});

	it('reads a saved queue and skips junk', () => {
		const body = buildSessionBody(block);
		expect(parseQueue([{ body, attempts: 2 }, { body: { x: 1 } }, null, 'x'])).toEqual([{ body, attempts: 2 }]);
		expect(parseQueue('nope')).toEqual([]);
	});

	it('makes v4 UUIDs', () => {
		expect(newBlockId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});

describe('KiriAccount with secret storage', () => {
	function memorySecrets(): SecretStore & { map: Map<string, string> } {
		const map = new Map<string, string>();
		return { map, getSecret: (id) => map.get(id) ?? null, setSecret: (id, v) => void map.set(id, v) };
	}
	function setupWith(secrets: SecretStore | null, routes: Record<string, Handler | Handler[]> = {}) {
		const { http, calls } = fakeHttp(routes);
		const c = clock();
		const account = new KiriAccount({ http, base: BASE, secrets, save: async () => {}, onChange: () => {}, openUrl: () => {}, wait: c.wait, now: c.now });
		return { account, calls };
	}

	it('keeps a new token in secret storage, not in data.json', async () => {
		const secrets = memorySecrets();
		const { account } = setupWith(secrets, {
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => res(200, TOKEN),
			'GET /api/device/me': () => res(200, ME),
		});
		await account.connect('x');
		const data = account.toData();
		expect(data.account).not.toHaveProperty('token');
		expect(JSON.stringify(data)).not.toContain(TOKEN.access_token);
		expect(secrets.getSecret(secretIdFor(data.account?.connectionId ?? ''))).toBe(TOKEN.access_token);

		const again = setupWith(secrets);
		again.account.load(JSON.parse(JSON.stringify(data)));
		expect(again.account.info?.token).toBe(TOKEN.access_token);
	});

	it('moves a token saved in data.json into secret storage', () => {
		const secrets = memorySecrets();
		const { account } = setupWith(secrets);
		expect(account.load({ account: { token: 'kdt_old_token', name: 'Sam' } })).toBe(true);
		expect(account.toData().account).not.toHaveProperty('token');
		expect([...secrets.map.values()]).toEqual(['kdt_old_token']);
	});

	it('is not connected on a device whose secret storage lacks the token', () => {
		const { account } = setupWith(memorySecrets());
		account.load({ account: { connectionId: 'conn-aaaa-1111', name: 'Sam' } });
		expect(account.connected).toBe(false);
	});

	it('keeps the token in data.json when secret storage is missing or fails', () => {
		const plain = setupWith(null);
		plain.account.load({ account: { token: 'kdt_old_token' } });
		expect(plain.account.toData().account?.token).toBe('kdt_old_token');

		const broken = setupWith({
			getSecret: () => null,
			setSecret: () => {
				throw new Error('locked');
			},
		});
		broken.account.load({ account: { token: 'kdt_old_token' } });
		expect(broken.account.toData().account?.token).toBe('kdt_old_token');
	});

	it('empties the secret on disconnect', async () => {
		const secrets = memorySecrets();
		const { account } = setupWith(secrets, { 'DELETE /api/device/token': () => res(204) });
		account.load({ account: { token: 'kdt_old_token' } });
		await account.disconnect();
		expect([...secrets.map.values()]).toEqual(['']);
		expect(account.connected).toBe(false);
	});
});

describe('KiriAccount', () => {
	function setup(routes: Record<string, Handler | Handler[]>) {
		const { http, calls } = fakeHttp(routes);
		const c = clock();
		const save = vi.fn(async () => {});
		const onDisconnected = vi.fn();
		const account = new KiriAccount({ http, base: BASE, save, onChange: () => {}, onDisconnected, openUrl: () => {}, wait: c.wait, now: c.now });
		return { account, calls, save, onDisconnected };
	}

	it('connects, stores the token and loads plan and sounds', async () => {
		const { account, save } = setup({
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => res(200, TOKEN),
			'GET /api/device/me': () => res(200, ME),
		});
		await account.connect('x');
		expect(account.connected).toBe(true);
		expect(account.info).toMatchObject({ token: TOKEN.access_token, name: 'Sam', plan: 'free', binaural: 'none' });
		expect(account.info?.sounds).toHaveLength(2);
		expect(save).toHaveBeenCalled();
		expect(account.toData().account?.token).toBe(TOKEN.access_token);
	});

	it('forgets the token on 401 from /me', async () => {
		const { account, onDisconnected } = setup({ 'GET /api/device/me': () => res(401, { error: 'invalid_token' }) });
		account.load({ account: { token: 'kdt_old_token', name: 'Sam' } });
		await account.refresh();
		expect(account.connected).toBe(false);
		expect(onDisconnected).toHaveBeenCalledOnce();
	});

	it('keeps the saved details when offline', async () => {
		const http: HttpFn = async () => {
			throw new Error('offline');
		};
		const account = new KiriAccount({ http, base: BASE, save: async () => {}, onChange: () => {}, openUrl: () => {}, wait: async () => {} });
		account.load({ account: { token: 'kdt_old_token', name: 'Sam', plan: 'paid' } });
		await account.refresh();
		expect(account.info).toMatchObject({ name: 'Sam', plan: 'paid' });
	});

	it('disconnect revokes the token and forgets it, even when the server is down', async () => {
		const { account, calls } = setup({ 'DELETE /api/device/token': () => res(204) });
		account.load({ account: { token: 'kdt_old_token' }, syncQueue: [{ body: { client_block_id: 'x', started_at: 't', duration_seconds: 1500 }, attempts: 0 }] });
		expect(account.queue).toHaveLength(1);
		await account.disconnect();
		expect(account.queue).toHaveLength(0);
		expect(calls[0]).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer kdt_old_token' } });
		expect(account.connected).toBe(false);

		const down = setup({ 'DELETE /api/device/token': () => res(503) });
		down.account.load({ account: { token: 'kdt_old_token' } });
		await down.account.disconnect();
		expect(down.account.connected).toBe(false);
	});

	it('queues a block, sends it, and keeps it when offline', async () => {
		let online = false;
		const { account, calls } = setup({
			'POST /api/device/focus-sessions': () => (online ? res(201, { id: '1', kiris_earned: 1 }) : res(503)),
		});
		account.load({ account: { token: 'kdt_old_token' } });
		const block = { id: 'b1', startedAt: 0, durationSeconds: 1500, sound: 'off', binaural: 'off', intent: '' };
		await account.sendBlock(block);
		expect(account.queue).toHaveLength(1);
		online = true;
		await account.sendBlock({ ...block, id: 'b2' });
		expect(account.queue).toHaveLength(0);
		const posted = calls.filter((r) => r.url.endsWith('/focus-sessions')).map((r) => (JSON.parse(r.body ?? '') as { client_block_id: string }).client_block_id);
		expect(posted).toEqual(['b1', 'b1', 'b2']);
	});

	it('does nothing with blocks when not connected', async () => {
		const { account, calls } = setup({});
		await account.sendBlock({ id: 'b1', startedAt: 0, durationSeconds: 1500, sound: 'off', binaural: 'off', intent: '' });
		expect(calls).toHaveLength(0);
		expect(account.queue).toHaveLength(0);
	});

	it('drops queued blocks when a 401 forgets the token, and never sends them to the next account', async () => {
		let revoked = true;
		const { account, calls, onDisconnected } = setup({
			'POST /api/device/focus-sessions': () => (revoked ? res(401, { error: 'invalid_token' }) : res(201, { id: '1', kiris_earned: 1 })),
			'POST /api/device/start': () => res(200, START),
			'POST /api/device/token': () => res(200, { ...TOKEN, access_token: 'kdt_second_account' }),
			'GET /api/device/me': () => res(200, ME),
		});
		account.load({ account: { token: 'kdt_old_token', connectionId: 'conn-aaaa-1111' } });
		const block = { id: 'b1', startedAt: 0, durationSeconds: 1500, sound: 'off', binaural: 'off', intent: 'Private task' };
		await account.sendBlock(block);
		expect(account.connected).toBe(false);
		expect(onDisconnected).toHaveBeenCalledOnce();
		expect(account.queue).toHaveLength(0);

		revoked = false;
		await account.connect('x');
		await account.flush();
		const posted = calls.filter((r) => r.url.endsWith('/focus-sessions'));
		expect(posted).toHaveLength(1);
		expect(posted[0]?.headers?.Authorization).toBe('Bearer kdt_old_token');
	});

	it('forgets queued blocks when a 401 comes from /me', async () => {
		const { account } = setup({ 'GET /api/device/me': () => res(401, { error: 'invalid_token' }) });
		account.load({
			account: { token: 'kdt_old_token', connectionId: 'conn-aaaa-1111' },
			syncQueue: [{ body: { client_block_id: 'x', started_at: new Date().toISOString(), duration_seconds: 1500 }, attempts: 0, connectionId: 'conn-aaaa-1111' }],
		});
		await account.refresh();
		expect(account.queue).toHaveLength(0);
	});

	it('only sends blocks recorded under the current connection', async () => {
		const { account, calls } = setup({ 'POST /api/device/focus-sessions': () => res(201, { id: '1', kiris_earned: 1 }) });
		const recent = new Date().toISOString();
		account.load({
			account: { token: 'kdt_old_token', connectionId: 'conn-mine-1111' },
			syncQueue: [
				{ body: { client_block_id: 'mine', started_at: recent, duration_seconds: 1500 }, attempts: 0, connectionId: 'conn-mine-1111' },
				{ body: { client_block_id: 'theirs', started_at: recent, duration_seconds: 1500 }, attempts: 0, connectionId: 'conn-other-2222' },
			],
		});
		expect(account.pendingCount).toBe(1);
		await account.flush();
		const posted = calls.map((r) => (JSON.parse(r.body ?? '{}') as { client_block_id?: string }).client_block_id);
		expect(posted).toEqual(['mine']);
		expect(account.queue.map((q) => q.body.client_block_id)).toEqual(['theirs']);
	});

	it('gives blocks saved by 0.1.0 to the loaded connection, or drops them without one', () => {
		const legacy = [{ body: { client_block_id: 'x', started_at: new Date().toISOString(), duration_seconds: 1500 }, attempts: 0 }];
		const { account } = setup({});
		expect(account.load({ account: { token: 'kdt_old_token' }, syncQueue: legacy })).toBe(true);
		expect(account.queue[0]?.connectionId).toBe(account.info?.connectionId);
		expect(account.pendingCount).toBe(1);

		const alone = setup({});
		alone.account.load({ account: null, syncQueue: legacy });
		expect(alone.account.queue).toHaveLength(0);
	});

	it('reads binaural "alpha" access', () => {
		expect(parseMe({ ...ME, binaural: 'alpha' }).binaural).toBe('alpha');
		expect(parseMe({ ...ME, binaural: 'full' }).binaural).toBe('full');
		expect(parseMe({ ...ME, binaural: 'theta-only' }).binaural).toBe('none');
	});

	it('ignores malformed saved accounts', () => {
		const { account } = setup({});
		account.load({ account: { token: 3 }, syncQueue: 'x' });
		expect(account.connected).toBe(false);
		expect(account.queue).toEqual([]);
	});
});

describe('kiris', () => {
	it('reads kiris_total from /me as a whole number, and treats anything unusable as unknown', () => {
		expect(parseMe({ ...ME, kiris_total: 123 }).kirisTotal).toBe(123);
		expect(parseMe({ ...ME, kiris_total: 0 }).kirisTotal).toBe(0);
		expect(parseMe({ ...ME, kiris_total: 12.9 }).kirisTotal).toBe(12);
		expect(parseMe(ME).kirisTotal).toBeNull();
		for (const bad of ['123', -1, null, NaN, Infinity, {}]) expect(parseMe({ ...ME, kiris_total: bad }).kirisTotal).toBeNull();
		expect(parseKiriCount(Number.MAX_SAFE_INTEGER * 4)).toBeNull();
	});

	it('counts kiris_earned (fractions too) only for a new block (201), never for a repeat (200)', () => {
		expect(parseKirisEarned(201, { id: '1', kiris_earned: 2 })).toBe(2);
		expect(parseKirisEarned(201, { id: '1', kiris_earned: 0.4 })).toBe(0.4);
		expect(parseKirisEarned(201, { id: '1', kiris_earned: 0.456 })).toBe(0.46);
		expect(parseKirisEarned(200, { id: '1', kiris_earned: 2 })).toBe(0);
		expect(parseKirisEarned(201, { id: '1' })).toBe(0);
		expect(parseKirisEarned(201, { id: '1', kiris_earned: '2' })).toBe(0);
		expect(parseKirisEarned(201, { id: '1', kiris_earned: -1 })).toBe(0);
		expect(parseKirisEarned(201, null)).toBe(0);
	});

	it('formats the total and the kiris earned', () => {
		expect(formatKiris(0)).toBe('0 kiris');
		expect(formatKiris(1)).toBe('1 kiri');
		expect(formatKiris(123)).toBe('123 kiris');
		expect(formatEarnedKiris(0.4)).toBe('0.4 kiri');
		expect(formatEarnedKiris(1)).toBe('1 kiri');
		expect(formatEarnedKiris(1.0)).toBe('1 kiri');
		expect(formatEarnedKiris(1.46)).toBe('1.5 kiris');
		expect(formatEarnedKiris(2)).toBe('2 kiris');
		expect(formatEarnedKiris(0.04)).toBe('');
	});

	it('adds up the kiris of every block a flush sends', async () => {
		const q = enqueue(enqueue([], buildSessionBody({ id: 'a', startedAt: 0, durationSeconds: 1500, sound: 'off', binaural: 'off', intent: '' })), buildSessionBody({ id: 'b', startedAt: 0, durationSeconds: 1500, sound: 'off', binaural: 'off', intent: '' }));
		const result = await flushQueue(q, async (body) => ({ kirisEarned: body.client_block_id === 'a' ? 0.1 : 0.2 }));
		expect(result).toMatchObject({ sent: 2, kirisEarned: 0.3 });
	});

	function setupKiris(routes: Record<string, Handler | Handler[]>) {
		const { http, calls } = fakeHttp(routes);
		const earned: number[] = [];
		const sent = { count: 0 };
		const account = new KiriAccount({
			http,
			base: BASE,
			save: async () => {},
			onChange: () => {},
			onKirisEarned: (n) => earned.push(n),
			onBlocksSent: () => sent.count++,
			openUrl: () => {},
			wait: async () => {},
		});
		return { account, calls, earned, sent };
	}
	const block = { id: 'b1', startedAt: Date.now(), durationSeconds: 1500, sound: 'off', binaural: 'off', intent: '' };

	it('reports kiris when a block syncs and leaves the total to the next /me', async () => {
		const { account, earned } = setupKiris({
			'GET /api/device/me': [() => res(200, { ...ME, kiris_total: 10 }), () => res(200, { ...ME, kiris_total: 11 })],
			'POST /api/device/focus-sessions': () => res(201, { id: '1', kiris_earned: 0.4 }),
		});
		account.load({ account: { token: 'kdt_old_token' } });
		await account.refresh();
		expect(account.info?.kirisTotal).toBe(10);
		await account.sendBlock(block);
		expect(earned).toEqual([0.4]);
		// The server rounds its sum down, so the plugin never adds locally.
		expect(account.info?.kirisTotal).toBe(10);
		await account.refresh();
		expect(account.info?.kirisTotal).toBe(11);
		expect(account.toData().account?.kirisTotal).toBe(11);
	});

	it('says nothing for 0 kiris or a repeat, and keeps an unknown total unknown', async () => {
		const { account, earned, sent } = setupKiris({
			'POST /api/device/focus-sessions': [() => res(201, { id: '1', kiris_earned: 0 }), () => res(200, { id: '1', kiris_earned: 1 })],
		});
		account.load({ account: { token: 'kdt_old_token' } });
		await account.sendBlock(block);
		await account.sendBlock({ ...block, id: 'b2' });
		expect(earned).toEqual([]);
		expect(account.info?.kirisTotal).toBeNull();
		// The total is still read again: a retried block that counts 0 may have changed it (review N4).
		expect(sent.count).toBe(2);
	});

	it('counts queued offline blocks when they are sent', async () => {
		let online = false;
		const { account, earned, sent } = setupKiris({
			'POST /api/device/focus-sessions': () => (online ? res(201, { id: '1', kiris_earned: 1 }) : res(0)),
		});
		account.load({ account: { token: 'kdt_old_token', kirisTotal: 5 } });
		expect(account.info?.kirisTotal).toBe(5);
		await account.sendBlock(block);
		expect(earned).toEqual([]);
		expect(sent.count).toBe(0);
		online = true;
		await account.flush();
		expect(earned).toEqual([1]);
		expect(account.info?.kirisTotal).toBe(5);
	});
});

describe('KiriAccount on devices sharing a vault (review 2, code S3)', () => {
	function memorySecrets(): SecretStore {
		const map = new Map<string, string>();
		return { getSecret: (id) => map.get(id) ?? null, setSecret: (id, v) => void map.set(id, v) };
	}
	function memoryDevice(): DeviceStore & { map: Map<string, unknown> } {
		const map = new Map<string, unknown>();
		return { map, load: (k): unknown => (map.has(k) ? (JSON.parse(JSON.stringify(map.get(k))) as unknown) : null), save: (k, v) => void map.set(k, v) };
	}
	function device(secrets: SecretStore | null, local: DeviceStore | null, routes: Record<string, Handler | Handler[]> = {}) {
		const { http } = fakeHttp(routes);
		const c = clock();
		const onDisconnected = vi.fn();
		const account = new KiriAccount({ http, base: BASE, secrets, local, save: async () => {}, onChange: () => {}, onDisconnected, openUrl: () => {}, wait: c.wait, now: c.now });
		return { account, onDisconnected };
	}
	const CONNECT = {
		'POST /api/device/start': () => res(200, START),
		'POST /api/device/token': () => res(200, TOKEN),
		'GET /api/device/me': () => res(200, ME),
	};

	it('with device storage, data.json never holds this device\'s account, so the phone cannot wipe it', async () => {
		const laptopSecrets = memorySecrets();
		const laptopLocal = memoryDevice();
		const laptop = device(laptopSecrets, laptopLocal, CONNECT);
		await laptop.account.connect('x');
		laptop.account.saveDevice();
		let shared: Record<string, unknown> = { ...laptop.account.toData() };
		expect(shared).toEqual({});
		expect(laptopLocal.map.get(DEVICE_KEY)).toMatchObject({ account: { name: 'Sam' } });

		// The phone (no secret, its own empty device storage) saves data.json.
		const phone = device(memorySecrets(), memoryDevice());
		phone.account.load(shared);
		shared = { ...phone.account.toData() };

		const again = device(laptopSecrets, laptopLocal);
		again.account.load(shared);
		expect(again.account.connected).toBe(true);
		expect(again.account.tokenPlace).toBe('secret');
	});

	it('moves this device\'s account out of data.json once, and leaves another device\'s alone', () => {
		const secrets = memorySecrets();
		secrets.setSecret(secretIdFor('conn-aaaa-1111'), 'kdt_old_token');
		const queue = [{ body: { client_block_id: 'b1', started_at: new Date(0).toISOString(), duration_seconds: 1500 }, attempts: 0, connectionId: 'conn-aaaa-1111' }];
		const data = { account: { connectionId: 'conn-aaaa-1111', name: 'Sam' }, syncQueue: queue };

		const other = device(memorySecrets(), memoryDevice());
		expect(other.account.load(data)).toBe(false);
		expect(other.account.connected).toBe(false);
		expect(other.account.toData()).toEqual(data);

		const local = memoryDevice();
		const owner = device(secrets, local);
		expect(owner.account.load(data)).toBe(true);
		expect(owner.account.connected).toBe(true);
		expect(owner.account.queue).toHaveLength(1);
		expect(owner.account.toData()).toEqual({});
		expect(local.map.get(DEVICE_KEY)).toMatchObject({ account: { connectionId: 'conn-aaaa-1111' }, syncQueue: queue });
	});

	it('without device storage, a device that is not connected passes the account in data.json on unchanged', () => {
		const data = { account: { connectionId: 'conn-aaaa-1111', name: 'Sam' } };
		const phone = device(memorySecrets(), null);
		phone.account.load(data);
		expect(phone.account.toData().account).toEqual(data.account);
		// The laptop disconnects; the phone takes that from the synced file.
		phone.account.takeShared({ account: null });
		expect(phone.account.toData().account).toBeNull();
	});

	it('without secret storage, the token stays on the device, not in data.json', async () => {
		const local = memoryDevice();
		const { account } = device(null, local, CONNECT);
		await account.connect('x');
		account.saveDevice();
		expect(JSON.stringify(account.toData())).not.toContain(TOKEN.access_token);
		expect(account.tokenPlace).toBe('device');
		const again = device(null, local);
		again.account.load({});
		expect(again.account.info?.token).toBe(TOKEN.access_token);
	});

	it('Disconnect after the token was revoked on the site disconnects once, quietly (review 2, code N2)', async () => {
		const { account, onDisconnected } = device(null, null, { 'DELETE /api/device/token': () => res(401, { error: 'invalid_token' }) });
		account.load({ account: { token: 'kdt_old_token' } });
		await account.disconnect();
		expect(account.connected).toBe(false);
		expect(onDisconnected).not.toHaveBeenCalled();
	});
});
