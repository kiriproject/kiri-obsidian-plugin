import type { AccountSummary, KiriApi } from './api';
import { ApiError } from './api';

/** Seconds added to the poll interval when the server says slow_down (RFC 8628). */
export const SLOW_DOWN_SECONDS = 5;
/** Give up after this many network failures in a row while waiting. */
const MAX_NETWORK_FAILURES = 5;

export type FlowState =
	| { step: 'idle' }
	| { step: 'starting' }
	| { step: 'waiting'; userCode: string; verificationUrl: string; expiresAt: number }
	| { step: 'done'; token: string; account: AccountSummary }
	| { step: 'denied' }
	| { step: 'expired' }
	| { step: 'cancelled' }
	| { step: 'error'; message: string };

export interface FlowDeps {
	api: Pick<KiriApi, 'startDevice' | 'pollToken'>;
	openUrl: (url: string) => void;
	wait: (ms: number) => Promise<void>;
	now: () => number;
	onChange: (state: FlowState) => void;
}

/**
 * The device connection flow: ask for a code, open the browser, then poll
 * until the user allows or denies, the code expires, or the user cancels.
 */
export class DeviceFlow {
	state: FlowState = { step: 'idle' };
	private cancelled = false;
	/** Bumped by each run, so a loop from an earlier, cancelled run stops for good. */
	private runId = 0;
	private wakeUp: (() => void) | null = null;

	constructor(private readonly deps: FlowDeps) {}

	get active(): boolean {
		return this.state.step === 'starting' || this.state.step === 'waiting';
	}

	/** Stop polling. Safe to call at any time. */
	cancel(): void {
		if (!this.active) return;
		this.cancelled = true;
		this.set({ step: 'cancelled' });
		this.wakeUp?.();
	}

	async run(deviceName: string): Promise<FlowState> {
		if (this.active) return this.state;
		const run = ++this.runId;
		const over = (): boolean => this.cancelled || run !== this.runId;
		this.cancelled = false;
		this.set({ step: 'starting' });
		let start;
		try {
			start = await this.deps.api.startDevice(deviceName);
		} catch (err) {
			if (over()) return this.state;
			return this.finish({ step: 'error', message: messageOf(err) });
		}
		if (over()) return this.state;

		const expiresAt = this.deps.now() + start.expiresInSeconds * 1000;
		let intervalMs = Math.max(1, start.intervalSeconds) * 1000;
		this.set({ step: 'waiting', userCode: start.userCode, verificationUrl: start.verificationUrl, expiresAt });
		this.deps.openUrl(start.verificationUrl);

		let failures = 0;
		for (;;) {
			await this.sleep(intervalMs);
			if (over()) return this.state;
			if (this.deps.now() >= expiresAt) return this.finish({ step: 'expired' });
			let poll;
			try {
				poll = await this.deps.api.pollToken(start.deviceCode);
			} catch (err) {
				if (over()) return this.state;
				if (err instanceof ApiError && err.retryable && ++failures < MAX_NETWORK_FAILURES) continue;
				return this.finish({ step: 'error', message: messageOf(err) });
			}
			if (over()) return this.state;
			failures = 0;
			switch (poll.kind) {
				case 'pending':
					break;
				case 'slow_down':
					intervalMs += SLOW_DOWN_SECONDS * 1000;
					break;
				case 'denied':
					return this.finish({ step: 'denied' });
				case 'expired':
					return this.finish({ step: 'expired' });
				case 'ok':
					return this.finish({ step: 'done', token: poll.token, account: poll.account });
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.wakeUp = resolve;
			void this.deps.wait(ms).then(resolve);
		});
	}

	private finish(state: FlowState): FlowState {
		this.set(state);
		return state;
	}

	private set(state: FlowState): void {
		this.state = state;
		this.deps.onChange(state);
	}
}

function messageOf(err: unknown): string {
	return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}
