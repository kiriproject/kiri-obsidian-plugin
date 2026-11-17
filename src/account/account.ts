import {
	type AccountSummary,
	type BinauralAccess,
	type HttpFn,
	KiriApi,
	KIRI_API_BASE,
	type MeResponse,
	parseBinauralAccess,
	parseKiriCount,
	type Plan,
	type RemoteSound,
} from './api';
import { DeviceFlow, type FlowState } from './deviceFlow';
import { type BlockInfo, buildSessionBody, enqueue, flushQueue, newBlockId, parseQueue, type QueueItem } from './syncQueue';

/** The server refuses blocks that started longer ago than this, so older queued blocks are dropped. */
export const MAX_BLOCK_AGE_MS = 48 * 60 * 60 * 1000;

/** A connected account, in memory. */
export interface StoredAccount {
	token: string;
	/** Random id for this connection. Queued blocks and the stored secret are tied to it. */
	connectionId: string;
	name: string;
	emailHint: string;
	plan: Plan | null;
	trialEndsAt: string | null;
	sounds: RemoteSound[];
	binaural: BinauralAccess;
	/** Kiris on the account, from the last /me; null when unknown (hidden in the UI). */
	kirisTotal: number | null;
}

/** What goes into data.json: the token is left out when it is kept in Obsidian's secret storage. */
export type PersistedAccount = Omit<StoredAccount, 'token'> & { token?: string };

/**
 * The account fields of data.json. With device storage, Kiri leaves out its
 * own account and queue (they stay on this device) and passes on whatever
 * another device or an older version wrote there, untouched.
 */
export interface AccountData {
	/** Typed as Kiri writes it; a record passed on from another device is not checked. */
	account?: PersistedAccount | null;
	syncQueue?: QueueItem[];
}

/** What one device keeps for itself: its connection and its unsent blocks. */
export interface DeviceAccountRecord {
	account: PersistedAccount | null;
	syncQueue: QueueItem[];
}

/** Obsidian's vault-specific local storage on this device (app.loadLocalStorage, 1.8.7 and later), or a stand-in in tests. */
export interface DeviceStore {
	load(key: string): unknown;
	save(key: string, value: unknown): void;
}

/** Key of this plugin's record in the device storage. */
export const DEVICE_KEY = 'kiri-focus-timer-account';

/** Where the token of the current connection is kept. */
export type TokenPlace = 'secret' | 'device' | 'vault';

/** Obsidian's app.secretStorage (1.11.4 and later), or a stand-in in tests. */
export interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

export interface AccountDeps {
	http?: HttpFn;
	base?: string;
	/** Where to keep the token outside data.json, when Obsidian offers it. */
	secrets?: SecretStore | null;
	/**
	 * Device storage for the account record and the queue, when Obsidian offers
	 * it. Then data.json (which a sync service shares between devices) never
	 * holds this device's connection, so a device without it cannot wipe it.
	 */
	local?: DeviceStore | null;
	/** Persist toData(). */
	save: () => Promise<void>;
	/** Something visible changed (connection, plan, sounds, flow step, queue size). */
	onChange: () => void;
	/** The token stopped working (revoked on the site) and was forgotten. */
	onDisconnected?: () => void;
	/**
	 * Blocks that were sent just now earned this many kiris (more than 0, may be a
	 * fraction). The total is not changed here: the server rounds its sum down, so
	 * read it again from /me.
	 */
	onKirisEarned?: (kiris: number) => void;
	/**
	 * At least one block reached the server just now, whatever it earned (a block
	 * sent again after a lost answer counts 0 but may have changed the total).
	 */
	onBlocksSent?: () => void;
	openUrl: (url: string) => void;
	wait: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Secret ids may hold lowercase letters, digits and dashes. */
export function secretIdFor(connectionId: string): string {
	return `kiri-focus-timer-${connectionId}`;
}

export class KiriAccount {
	info: StoredAccount | null = null;
	queue: QueueItem[] = [];
	flowState: FlowState = { step: 'idle' };
	readonly api: KiriApi;
	private flow: DeviceFlow | null = null;
	private flushing: Promise<void> | null = null;
	/** True when the current token is in secret storage, so data.json does not hold it. */
	private tokenInSecrets = false;
	/**
	 * Account fields of data.json that are not this device's: written by another
	 * device sharing the vault (or by an older version), passed on unchanged.
	 */
	private passthrough: AccountData = {};
	/** True while Disconnect revokes the token. */
	private revoking = false;

	constructor(private readonly deps: AccountDeps) {
		this.api = new KiriApi(
			deps.http,
			() => this.info?.token ?? null,
			() => {
				// Disconnect forgets the token itself; a 401 from its revoke is not a second disconnect.
				if (this.revoking) return;
				this.forget(true).catch(() => {
					// Saving failed; the account is forgotten in memory anyway.
				});
			},
			deps.base ?? KIRI_API_BASE,
		);
	}

	get connected(): boolean {
		return this.info !== null;
	}

	/**
	 * Read the saved account and queue. Returns true when the data should be
	 * saved again, for example because a token was moved out of data.json into
	 * secret storage, or this device's account moved into device storage.
	 *
	 * With device storage, this device's own record comes from there. On the
	 * first start with device storage, an account in data.json that this device
	 * can use (its token is in this device's secret storage, or in data.json)
	 * moves there; one it cannot use belongs to another device and is left in
	 * data.json as it is.
	 */
	load(data: unknown): boolean {
		const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
		const shared = sharedFields(d);
		const local = this.readDevice();
		if (local) {
			const needsSave = this.loadRecord(local.account, local.syncQueue);
			this.passthrough = shared;
			if (needsSave) this.saveDevice();
			return false;
		}
		const needsSave = this.loadRecord(d.account, d.syncQueue);
		if (!this.info) {
			// Not this device's connection (or none): never overwrite it in data.json.
			this.passthrough = this.deps.local ? shared : shared.account ? { account: shared.account } : {};
			if (this.deps.local) this.queue = [];
			return this.deps.local ? false : needsSave;
		}
		this.passthrough = {};
		if (this.deps.local) {
			// This device's account: from now on kept on the device, and taken out of data.json.
			this.saveDevice();
			return true;
		}
		return needsSave;
	}

	/**
	 * data.json changed outside (synced from another device): take the fields
	 * that are not this device's from it, so the next save passes on the new ones.
	 */
	takeShared(data: unknown): void {
		const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
		const shared = sharedFields(d);
		if (this.deps.local) this.passthrough = shared;
		else if (!this.info) this.passthrough = shared.account ? { account: shared.account } : {};
	}

	/** Read an account record and queue; true when it should be saved again. */
	private loadRecord(rawAccount: unknown, rawQueue: unknown): boolean {
		const raw = rawAccount && typeof rawAccount === 'object' ? (rawAccount as Record<string, unknown>) : null;
		let needsSave = false;
		this.info = null;
		this.tokenInSecrets = false;
		const saved = parseStoredAccount(raw);
		if (saved) {
			let { token } = saved;
			if (!token) {
				// Kept in secret storage. Missing there (another device sharing this vault, or
				// secret storage was cleared) means this device is not connected.
				token = this.readSecret(saved.connectionId) ?? '';
				this.tokenInSecrets = token.length > 0;
			} else if (this.writeSecret(saved.connectionId, token)) {
				this.tokenInSecrets = true;
				needsSave = true;
			}
			if (token.length >= 8) this.info = { ...saved, token };
			if (raw && typeof raw.connectionId !== 'string') needsSave = true;
		}

		const id = this.info?.connectionId;
		const now = (this.deps.now ?? Date.now)();
		const queue: QueueItem[] = [];
		for (const item of parseQueue(rawQueue)) {
			if (!item.connectionId) {
				// Saved by 0.1.0, which had one connection at a time: it belongs to the
				// connection loaded with it, or to none.
				if (id) queue.push({ ...item, connectionId: id });
				needsSave = true;
				continue;
			}
			if (item.connectionId !== id && now - Date.parse(item.body.started_at) > MAX_BLOCK_AGE_MS) {
				// Another connection's block that the server would refuse by now anyway.
				needsSave = true;
				continue;
			}
			queue.push(item);
		}
		this.queue = queue;
		return needsSave;
	}

	/**
	 * The account fields for data.json. With device storage: only what other
	 * devices put there. Without: this device's account (token left out when it
	 * is in secret storage), or, when this device has none, the other device's
	 * record unchanged.
	 */
	toData(): AccountData {
		if (this.deps.local) return { ...this.passthrough };
		if (!this.info) return { account: this.passthrough.account ?? null, syncQueue: this.queue };
		return { account: this.persisted(), syncQueue: this.queue };
	}

	/** Save this device's record to device storage (when there is one). Called with every save. */
	saveDevice(): void {
		const local = this.deps.local;
		if (!local) return;
		const record: DeviceAccountRecord | null = this.info || this.queue.length > 0 ? { account: this.info ? this.persisted() : null, syncQueue: this.queue } : null;
		try {
			local.save(DEVICE_KEY, record);
		} catch {
			// Kept in memory; tried again with the next save.
		}
	}

	/** This device's account as saved: without the token when it is in secret storage. */
	private persisted(): PersistedAccount | null {
		if (!this.info) return null;
		const { token, ...rest } = this.info;
		return this.tokenInSecrets ? rest : { ...rest, token };
	}

	private readDevice(): { account: unknown; syncQueue: unknown } | null {
		try {
			const value: unknown = this.deps.local?.load(DEVICE_KEY);
			if (!value || typeof value !== 'object') return null;
			const v = value as Record<string, unknown>;
			return { account: v.account, syncQueue: v.syncQueue };
		} catch {
			return null;
		}
	}

	/** Where the current token is kept, or null when not connected. */
	get tokenPlace(): TokenPlace | null {
		if (!this.info) return null;
		if (this.tokenInSecrets) return 'secret';
		return this.deps.local ? 'device' : 'vault';
	}

	/** True when the token is in Obsidian's secret storage rather than in data.json. */
	get tokenInSecretStorage(): boolean {
		return this.info !== null && this.tokenInSecrets;
	}

	/** Blocks of the current connection that still have to be sent. */
	get pendingCount(): number {
		const id = this.info?.connectionId;
		return id ? this.queue.filter((q) => q.connectionId === id).length : 0;
	}

	/** Start the device flow. Resolves when it ends (connected, denied, expired, cancelled or failed). */
	async connect(deviceName: string): Promise<FlowState> {
		this.flow?.cancel();
		const flow = new DeviceFlow({
			api: this.api,
			openUrl: this.deps.openUrl,
			wait: this.deps.wait,
			now: this.deps.now ?? Date.now,
			onChange: (state) => {
				if (this.flow !== flow) return;
				this.flowState = state;
				this.deps.onChange();
			},
		});
		this.flow = flow;
		const result = await flow.run(deviceName);
		if (this.flow === flow && result.step === 'done') {
			const info = fromSummary(result.token, result.account, newBlockId());
			this.tokenInSecrets = this.writeSecret(info.connectionId, info.token);
			this.info = info;
			// Without device storage, data.json has one account slot: this connection takes it.
			if (!this.deps.local) this.passthrough = {};
			await this.deps.save();
			this.deps.onChange();
			await this.refresh();
		}
		return result;
	}

	cancelConnect(): void {
		this.flow?.cancel();
	}

	/** Forget the last flow result (for example after showing "Code expired"). */
	resetFlow(): void {
		if (this.flow?.active) return;
		this.flowState = { step: 'idle' };
		this.deps.onChange();
	}

	/** Fetch account details, plan and sounds. Keeps the saved copy when offline. */
	async refresh(): Promise<MeResponse | null> {
		if (!this.info) return null;
		try {
			const me = await this.api.me();
			if (!this.info) return null;
			this.info = applyMe(this.info, me);
			await this.deps.save();
			this.deps.onChange();
			return me;
		} catch {
			// 401 already disconnected us; other errors keep the saved details.
			return null;
		}
	}

	/** Revoke the token on the server (best effort), forget it here and drop unsent blocks. */
	async disconnect(): Promise<void> {
		if (!this.info) return;
		this.revoking = true;
		try {
			await this.api.revoke();
		} catch {
			// Offline or already revoked (401): forget it locally anyway. It can also be removed on the site.
		} finally {
			this.revoking = false;
		}
		await this.forget(false);
	}

	/** Queue a finished block and try to send everything queued. Never throws. */
	async sendBlock(block: BlockInfo): Promise<void> {
		if (!this.info) return;
		this.queue = enqueue(this.queue, buildSessionBody(block), this.info.connectionId);
		try {
			await this.deps.save();
			await this.flush();
		} catch {
			// Saving failed; the block stays queued in memory and is tried again later.
		}
	}

	/** Send queued blocks. Safe to call often; only one flush runs at a time. */
	flush(): Promise<void> {
		if (!this.info || this.pendingCount === 0) return Promise.resolve();
		if (!this.flushing) {
			this.flushing = this.doFlush()
				.catch(() => {
					// Kept for the next try.
				})
				.finally(() => {
					this.flushing = null;
				});
		}
		return this.flushing;
	}

	/** Drop this connection's unsent blocks. */
	clearQueue(): Promise<void> {
		const id = this.info?.connectionId;
		this.queue = this.queue.filter((q) => q.connectionId !== id);
		this.deps.onChange();
		return this.deps.save();
	}

	private async doFlush(): Promise<void> {
		const id = this.info?.connectionId;
		if (!id) return;
		const mine = this.queue.filter((q) => q.connectionId === id);
		const result = await flushQueue(mine, (body) => this.api.postFocusSession(body));
		if (this.info?.connectionId !== id) {
			// Disconnected (for example a 401) or connected again while sending: this
			// connection's blocks must not survive into the next one.
			this.queue = this.queue.filter((q) => q.connectionId !== id);
			await this.deps.save();
			this.deps.onChange();
			return;
		}
		// Blocks queued while this flush ran, and other connections' blocks, are kept after the ones still waiting.
		const rest = this.queue.filter((q) => !mine.includes(q));
		this.queue = [...result.remaining, ...rest];
		await this.deps.save();
		this.deps.onChange();
		if (result.kirisEarned > 0) this.deps.onKirisEarned?.(result.kirisEarned);
		if (result.sent > 0) this.deps.onBlocksSent?.();
		// Everything earlier went through, so send what came in meanwhile too.
		const added = rest.some((q) => q.connectionId === id);
		if (added && result.remaining.length === 0 && !result.unauthorized) await this.doFlush();
	}

	/**
	 * Forget the token, whatever the reason (Disconnect, or a 401 after it was
	 * revoked on the site), and drop the blocks queued under it, so they are
	 * never sent to an account connected later.
	 */
	private async forget(fromServer: boolean): Promise<void> {
		const info = this.info;
		if (!info) return;
		this.info = null;
		this.queue = this.queue.filter((q) => q.connectionId !== info.connectionId);
		if (this.tokenInSecrets) this.writeSecret(info.connectionId, '');
		this.tokenInSecrets = false;
		await this.deps.save();
		this.deps.onChange();
		if (fromServer) this.deps.onDisconnected?.();
	}

	private readSecret(connectionId: string): string | null {
		try {
			return this.deps.secrets?.getSecret(secretIdFor(connectionId)) || null;
		} catch {
			return null;
		}
	}

	/** True when the secret was stored. */
	private writeSecret(connectionId: string, value: string): boolean {
		if (!this.deps.secrets) return false;
		try {
			this.deps.secrets.setSecret(secretIdFor(connectionId), value);
			return true;
		} catch {
			return false;
		}
	}
}

/** The account fields of data.json as they are, to pass on unchanged. */
function sharedFields(d: Record<string, unknown>): AccountData {
	const shared: AccountData = {};
	if (d.account !== undefined) shared.account = d.account as AccountData['account'];
	if (d.syncQueue !== undefined) shared.syncQueue = d.syncQueue as AccountData['syncQueue'];
	return shared;
}

export function fromSummary(token: string, account: AccountSummary, connectionId: string): StoredAccount {
	return {
		token,
		connectionId,
		name: account.name,
		emailHint: account.emailHint,
		plan: null,
		trialEndsAt: null,
		sounds: [],
		binaural: 'none',
		kirisTotal: null,
	};
}

export function applyMe(info: StoredAccount, me: MeResponse): StoredAccount {
	return {
		...info,
		name: me.account.name || info.name,
		emailHint: me.account.emailHint || info.emailHint,
		plan: me.plan,
		trialEndsAt: me.trialEndsAt,
		sounds: me.sounds,
		binaural: me.binaural,
		kirisTotal: me.kirisTotal,
	};
}

const CONNECTION_ID_RE = /^[a-z0-9-]{8,64}$/;

/**
 * Read a saved account. The token may be missing (it is then in secret
 * storage); an account saved by 0.1.0 has no connection id and gets one.
 */
export function parseStoredAccount(value: unknown): PersistedAccount & { token: string } | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Partial<Record<keyof StoredAccount, unknown>>;
	const token = typeof v.token === 'string' ? v.token : '';
	const connectionId = typeof v.connectionId === 'string' && CONNECTION_ID_RE.test(v.connectionId) ? v.connectionId : null;
	// Without a token, the connection id is the only way to find it again.
	if (token.length < 8 && !connectionId) return null;
	if (token.length > 0 && token.length < 8) return null;
	const sounds = Array.isArray(v.sounds)
		? v.sounds.filter(
				(s): s is RemoteSound =>
					!!s && typeof s === 'object' && typeof (s as RemoteSound).key === 'string' && typeof (s as RemoteSound).label === 'string',
			)
		: [];
	return {
		token,
		connectionId: connectionId ?? newBlockId(),
		name: typeof v.name === 'string' ? v.name : '',
		emailHint: typeof v.emailHint === 'string' ? v.emailHint : '',
		plan: v.plan === 'free' || v.plan === 'trial' || v.plan === 'paid' ? v.plan : null,
		trialEndsAt: typeof v.trialEndsAt === 'string' ? v.trialEndsAt : null,
		sounds: sounds.map((s) => ({ key: s.key, label: s.label, available: s.available === true })),
		binaural: parseBinauralAccess(v.binaural),
		kirisTotal: parseKiriCount(v.kirisTotal),
	};
}
