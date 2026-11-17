import { type App, type ButtonComponent, type DropdownComponent, Notice, PluginSettingTab, Setting, type TextComponent } from 'obsidian';
import type { TokenPlace } from '../account/account';
import { PRICING_URL } from '../account/api';
import type { BinauralChoice } from '../audio/binaural';
import { formatBytes } from '../audio/soundCache';
import type KiriPlugin from '../main';
import { MAX_BREAK_MINUTES, MAX_MINUTES, MIN_BREAK_MINUTES, MIN_MINUTES, readNumberField } from '../logic/duration';
import { CHIME_LABELS, type ChimeStyle, type SoundChoice } from '../settings';
import { FALLBACK_LOG_NOTE, readDailyNotesConfig } from '../vault/dailyNote';

/** Where the connection key is kept, in the words the settings use. */
const TOKEN_PLACE_TEXT: Record<TokenPlace, string> = {
	secret: "The connection key is kept in Obsidian's secret storage on this device, not in your vault files.",
	device: "The connection key is kept in Obsidian's local storage on this device, not in your vault files (this Obsidian version has no secret storage).",
	vault: 'The connection key is stored in plain text in this vault, in the plugin folder (data.json).',
};

export class KiriSettingTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;
	/** The sound and account parts live in their own containers and are redrawn alone. */
	private soundEl: HTMLElement | null = null;
	private accountEl: HTMLElement | null = null;
	/** The break length part; redrawn alone when Auto is switched on or off (also from the panel). */
	private breakEl: HTMLElement | null = null;
	private breakAuto: boolean | null = null;
	private breakField: HTMLInputElement | null = null;
	/** What each part looked like when drawn; redraw only when it changes. */
	private soundKey = '';
	private accountKey = '';
	private cacheDescEl: HTMLElement | null = null;
	private cacheButton: ButtonComponent | null = null;
	private lastLoading: string | null = null;
	private visible = false;

	constructor(
		app: App,
		private readonly plugin: KiriPlugin,
	) {
		super(app, plugin);
	}

	hide(): void {
		this.visible = false;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.soundEl = null;
		this.accountEl = null;
		this.breakEl = null;
		this.breakField = null;
		this.cacheDescEl = null;
		this.cacheButton = null;
		// A connection that is still waiting keeps going (the browser may be open on top of
		// Obsidian, for example on a phone); its result is shown as a Notice.
		this.plugin.account.resetFlow();
		super.hide();
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();
		this.visible = true;
		if (!this.unsubscribe) {
			this.unsubscribe = this.plugin.subscribe((event) => {
				if (event !== 'change') return;
				if (this.soundSignature() !== this.soundKey) this.drawSound();
				else if (this.lastLoading !== this.plugin.soundLoading) {
					// A download finished or started: only the size line changes.
					this.lastLoading = this.plugin.soundLoading;
					this.updateCacheSize();
				}
				if (this.accountSignature() !== this.accountKey) this.drawAccount();
				this.syncBreak();
			});
		}

		this.numberSetting(
			new Setting(containerEl)
				.setName('Focus length')
				.setDesc(`Minutes per focus block, from ${MIN_MINUTES} to ${MAX_MINUTES}. The buttons in the Kiri view change this too.`),
			MIN_MINUTES,
			MAX_MINUTES,
			() => s.focusMinutes,
			(minutes) => this.plugin.setFocusMinutes(minutes),
		);

		new Setting(containerEl)
			.setName('Chime')
			.setDesc('Play a soft chime when a focus block or break ends.')
			.addToggle((t) =>
				t.setValue(s.chime).onChange(async (v) => {
					s.chime = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Chime sound')
			.addDropdown((d) =>
				d
					.addOptions(CHIME_LABELS)
					.setValue(s.chimeStyle)
					.onChange(async (v) => {
						s.chimeStyle = v as ChimeStyle;
						await this.plugin.saveSettings();
					}),
			)
			.addExtraButton((b) =>
				b
					.setIcon('play')
					.setTooltip('Play the chime')
					.onClick(() => this.plugin.previewChime()),
			);

		new Setting(containerEl).setName('Breaks').setHeading();

		new Setting(containerEl)
			.setName('Take a break after each block')
			.setDesc('The sound fades out during the break and fades back in when the next block starts.')
			.addToggle((t) =>
				t.setValue(s.breaksEnabled).onChange(async (v) => {
					s.breaksEnabled = v;
					await this.plugin.saveSettings();
				}),
			);

		this.breakEl = containerEl.createDiv();
		this.drawBreak();

		new Setting(containerEl)
			.setName('Long break')
			.setDesc('Take a longer break after every few blocks.')
			.addToggle((t) =>
				t.setValue(s.longBreakEnabled).onChange(async (v) => {
					s.longBreakEnabled = v;
					await this.plugin.saveSettings();
				}),
			);

		this.numberSetting(
			new Setting(containerEl).setName('Long break length').setDesc('Minutes, from 1 to 60.'),
			1,
			60,
			() => s.longBreakMinutes,
			(minutes) => {
				s.longBreakMinutes = minutes;
				void this.plugin.saveSettings();
			},
		);

		this.numberSetting(
			new Setting(containerEl).setName('Long break every').setDesc('Number of blocks, from 2 to 12. A gap of two hours starts the count again.'),
			2,
			12,
			() => s.longBreakEvery,
			(n) => {
				s.longBreakEvery = n;
				void this.plugin.saveSettings();
			},
		);

		new Setting(containerEl)
			.setName('Start the break by itself')
			.setDesc('When off, Kiri waits for you to start the break after a block.')
			.addToggle((t) =>
				t.setValue(s.autoStartBreak).onChange(async (v) => {
					s.autoStartBreak = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Start the next block after the break')
			.setDesc(
				'When off, Kiri waits for you to press start. When on, Kiri still waits after a long break, after 4 blocks in a row started by themselves, and after a break that ended while the device slept.',
			)
			.addToggle((t) =>
				t.setValue(s.autoStartNext).onChange(async (v) => {
					s.autoStartNext = v;
					await this.plugin.saveSettings();
				}),
			);

		this.soundEl = containerEl.createDiv();
		this.drawSound();

		new Setting(containerEl).setName('Focus log').setHeading();

		const daily = readDailyNotesConfig(this.app);
		new Setting(containerEl)
			.setName('Log each block')
			.setDesc(
				daily.enabled
					? 'Add a line to today\'s daily note when a focus block ends. Uses the folder, date format and template of the Daily notes core plugin.'
					: `The Daily notes core plugin is off, so lines go to "${FALLBACK_LOG_NOTE}" in the vault root. Turn on Daily notes to log to today's note instead.`,
			)
			.addToggle((t) =>
				t.setValue(s.logToDailyNote).onChange(async (v) => {
					s.logToDailyNote = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Create the daily note if it is missing')
			.setDesc(
				`Off: when today's daily note does not exist yet, the line goes to "${FALLBACK_LOG_NOTE}" and Kiri says so. This way Kiri never makes a second "today" note before a sync service brings the one you wrote on another device. On: Kiri creates the note from your Daily notes template (never an empty note when the template cannot be found).`,
			)
			.addToggle((t) =>
				t.setValue(s.createDailyNote).onChange(async (v) => {
					s.createDailyNote = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Log heading')
			.setDesc('Lines go under this heading. It is added if the note does not have it.')
			.addText((text) =>
				text
					.setPlaceholder('## Focus log')
					.setValue(s.logHeading)
					.then((field) => {
						// Saved when the field is left or Enter is pressed, not on every keystroke.
						field.inputEl.addEventListener('change', () => {
							const v = field.getValue();
							s.logHeading = v.trim().length > 0 ? v : '## Focus log';
							field.setValue(s.logHeading);
							void this.plugin.saveSettings();
						});
					}),
			);

		new Setting(containerEl).setName('Tasks').setHeading();

		new Setting(containerEl)
			.setName('Count blocks on the task')
			.setDesc('Add or update a [kiri:: 2] field on the task line after each block. Dataview can read it.')
			.addToggle((t) =>
				t.setValue(s.taskCounter).onChange(async (v) => {
					s.taskCounter = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Add time spent to the task')
			.setDesc('After each block, add its minutes to a [spent:: 1h 15m] field on the task line. Add [planned:: 2h] yourself to see planned against spent in the Kiri view. Tasks plugin dates stay at the end of the line. A [spent:: ...] you already use is read as time (a plain number as minutes) and rewritten, for example [spent:: 20] becomes [spent:: 45m]; a value Kiri cannot read is left alone.')
			.addToggle((t) =>
				t.setValue(s.writeSpent).onChange(async (v) => {
					s.writeSpent = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Ask to mark the task done')
			.setDesc('After each block, ask whether to mark the task done. Uses the Tasks plugin if it is on.')
			.addToggle((t) =>
				t.setValue(s.askMarkDone).onChange(async (v) => {
					s.askMarkDone = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Keep the Today list across days')
			.setDesc('When off, the Today list in the Kiri view starts empty each day at midnight.')
			.addToggle((t) =>
				t.setValue(s.keepToday).onChange(async (v) => {
					s.keepToday = v;
					await this.plugin.saveSettings();
				}),
			);

		this.accountEl = containerEl.createDiv();
		this.drawAccount();
	}

	private drawSound(): void {
		const el = this.soundEl;
		if (!el) return;
		el.empty();
		this.soundKey = this.soundSignature();
		this.lastLoading = this.plugin.soundLoading;
		this.cacheDescEl = null;
		this.cacheButton = null;
		const s = this.plugin.settings;

		new Setting(el).setName('Sound').setHeading();

		const connected = this.plugin.account.connected;
		new Setting(el)
			.setName(connected ? 'Sound' : 'Noise')
			.setDesc(
				connected
					? 'Kiri sounds are downloaded the first time you play them, about 15 to 25 MB each, and kept in the plugin folder. Noise is made on your device.'
					: 'Noise made on your device while you focus. Nothing is downloaded.',
			)
			.addDropdown((d) => {
				this.fillSounds(d);
				d.onChange((v) => {
					if (!this.plugin.setSound(v as SoundChoice)) d.setValue(this.plugin.settings.sound);
				});
			});

		new Setting(el).setName('Volume').addSlider((sl) =>
			sl
				.setLimits(0, 100, 1)
				.setValue(s.volume)
				.onChange((v) => this.plugin.setVolume(v)),
		);

		if (connected) {
			const cache = new Setting(el)
				.setName('Downloaded sounds')
				.setDesc('Checking…')
				.addButton((b) => {
					this.cacheButton = b;
					b.setButtonText('Clear downloaded sounds')
						.setDisabled(true)
						.onClick(async () => {
							b.setDisabled(true);
							try {
								await this.plugin.clearDownloadedSounds();
								new Notice('Downloaded Kiri sounds deleted.');
							} catch {
								new Notice('Kiri could not delete the downloaded sounds.');
							}
							this.updateCacheSize();
						});
				});
			this.cacheDescEl = cache.descEl;
			this.updateCacheSize();
		}

		if (this.plugin.binauralAllowed()) {
			new Setting(el)
				.setName('Binaural beats')
				.setDesc(
					this.plugin.account.info?.binaural === 'alpha'
						? 'Two steady tones, one in each ear, a few hertz apart. Made on your device. Use headphones. Your Kiri account includes the Alpha beat.'
						: 'Two steady tones, one in each ear, a few hertz apart. Made on your device. Use headphones.',
				)
				.addDropdown((d) =>
					d
						.addOptions(this.plugin.binauralOptions())
						.setValue(this.plugin.beatAllowed(s.binaural) ? s.binaural : 'off')
						.onChange((v) => this.plugin.setBinaural(v as BinauralChoice)),
				);
			new Setting(el)
				.setName('Binaural volume')
				.setDesc('Kept quiet: even at the top of the slider the tones stay soft.')
				.addSlider((sl) =>
					sl
						.setLimits(0, 100, 1)
						.setValue(s.binauralVolume)
						.onChange((v) => this.plugin.setBinauralVolume(v)),
				);
		}
	}

	/** Fill in the "Downloaded sounds" line: how many, how big, and where. */
	private updateCacheSize(): void {
		const desc = this.cacheDescEl;
		const button = this.cacheButton;
		if (!desc) return;
		void this.plugin.downloadedSoundsSize().then(({ files, bytes }) => {
			if (this.cacheDescEl !== desc) return;
			const where = `${this.plugin.soundsFolder()}/`;
			desc.setText(
				files === 0
					? `None yet. Sounds you play are saved in ${where}`
					: `${files === 1 ? '1 sound' : `${files} sounds`}, ${formatBytes(bytes)}, in ${where}. A sound you delete is downloaded again the next time you play it.`,
			);
			button?.setDisabled(files === 0);
		});
	}

	private soundSignature(): string {
		const { account } = this.plugin;
		return JSON.stringify([account.connected, account.info?.sounds, account.info?.binaural]);
	}

	private fillSounds(d: DropdownComponent): void {
		for (const option of this.plugin.soundOptions()) d.addOption(option.value, option.label);
		d.setValue(this.plugin.settings.sound);
	}

	private accountSignature(): string {
		const { account } = this.plugin;
		const f = account.flowState;
		return JSON.stringify([
			account.info?.name,
			account.info?.emailHint,
			account.info?.plan,
			account.info?.trialEndsAt,
			account.info?.binaural,
			account.info?.sounds,
			account.pendingCount,
			f.step,
			f.step === 'waiting' ? f.userCode : '',
			f.step === 'error' ? f.message : '',
		]);
	}

	private drawAccount(): void {
		const containerEl = this.accountEl;
		if (!containerEl) return;
		containerEl.empty();
		this.accountKey = this.accountSignature();
		const { plugin } = this;
		const { account } = plugin;
		new Setting(containerEl).setName('Kiri account').setHeading();

		const info = account.info;
		if (info) {
			const plan =
				info.plan === 'paid'
					? 'Paid plan'
					: info.plan === 'trial'
						? info.trialEndsAt
							? `Trial until ${new Date(info.trialEndsAt).toLocaleDateString()}`
							: 'Trial'
						: info.plan === 'free'
							? 'Free plan'
							: '';
			new Setting(containerEl)
				.setName(info.name ? `Connected as ${info.name}` : 'Connected')
				.setDesc([info.emailHint, plan].filter(Boolean).join(' · '))
				.addButton((b) =>
					b.setButtonText('Refresh').onClick(async () => {
						b.setDisabled(true);
						await account.refresh();
						b.setDisabled(false);
					}),
				)
				.addButton((b) =>
					b
						.setButtonText('Disconnect')
						.onClick(async () => {
							b.setDisabled(true);
							await plugin.disconnectAccount();
							new Notice('Kiri account disconnected.');
						}),
				);

			if (plugin.hasLockedSounds()) {
				new Setting(containerEl).setName('More sounds').setDesc(
					createFragment((f) => {
						f.appendText('Sounds marked locked need a paid Kiri account. ');
						f.createEl('a', { text: 'See plans', href: PRICING_URL });
					}),
				);
			}

			new Setting(containerEl)
				.setName('Send finished blocks to Kiri')
				.setDesc('Adds each finished block to your Kiri history: start time, length, sound and task text (up to 200 characters).')
				.addToggle((t) =>
					t.setValue(plugin.settings.syncEnabled).onChange(async (v) => {
						plugin.settings.syncEnabled = v;
						await plugin.saveSettings();
					}),
				);

			if (account.pendingCount > 0) {
				const n = account.pendingCount;
				new Setting(containerEl)
					.setName(n === 1 ? '1 block waiting to be sent' : `${n} blocks waiting to be sent`)
					.setDesc('Kiri tries again at startup and after your next block.')
					.addButton((b) => b.setButtonText('Send now').onClick(() => void account.flush()))
					.addButton((b) => b.setButtonText('Clear').onClick(() => void account.clearQueue()));
			}

			containerEl.createDiv({
				cls: 'setting-item-description kiri-account-note',
				text: `${TOKEN_PLACE_TEXT[account.tokenPlace ?? 'vault']} Disconnect removes it here and on Kiri. You can also remove it on project-kiri.com under connected apps.`,
			});
			return;
		}

		const flow = account.flowState;
		const connect = (): void => {
			void account.connect(plugin.deviceName()).then((result) => {
				if (result.step === 'done') {
					new Notice('Kiri account connected.');
					return;
				}
				// With settings open the result is shown there; once closed, say it here.
				if (this.visible) return;
				if (result.step === 'denied') new Notice('The Kiri connection was not allowed.');
				else if (result.step === 'expired') new Notice('The Kiri connection code expired. You can connect again in settings.');
				else if (result.step === 'error') new Notice(`Kiri could not connect: ${result.message}`);
			});
		};

		if (flow.step === 'starting') {
			new Setting(containerEl).setName('Connecting…').addButton((b) => b.setButtonText('Cancel').onClick(() => account.cancelConnect()));
			return;
		}

		if (flow.step === 'waiting') {
			const setting = new Setting(containerEl)
				.setName('Check the code in your browser')
				.setDesc(
					'A Kiri page opened in your browser. Sign in if asked, check that it shows this code, then click allow. You can close settings meanwhile; Kiri keeps waiting until the code expires.',
				)
				.addButton((b) => b.setButtonText('Open the page again').onClick(() => window.open(flow.verificationUrl)))
				.addButton((b) => b.setButtonText('Cancel').onClick(() => account.cancelConnect()));
			setting.descEl.createDiv({ cls: 'kiri-user-code', text: flow.userCode });
			return;
		}

		const problem =
			flow.step === 'denied'
				? 'The connection was not allowed.'
				: flow.step === 'expired'
					? 'The code expired before it was used.'
					: flow.step === 'error'
						? flow.message
						: '';
		new Setting(containerEl)
			.setName('Connect a Kiri account')
			.setDesc(
				problem ||
					'Optional. Use your Kiri sounds here and add finished blocks to your Kiri history, where they also count kiris. Once connected, each finished block is sent to Kiri with its task text (up to 200 characters), start time, length and sound; you can turn that off in this section. Everything else works without an account.',
			)
			.addButton((b) =>
				b
					.setButtonText(problem ? 'Try again' : 'Connect')
					.setCta()
					.onClick(connect),
			);
	}

	/**
	 * Break length: Auto (by block length) or set minutes, the same choice as the
	 * Break row in the panel. The three by-length fields are shown only with Auto.
	 */
	private drawBreak(): void {
		const el = this.breakEl;
		if (!el) return;
		el.empty();
		const s = this.plugin.settings;
		this.breakAuto = s.breakMinutes === null;
		this.breakField = null;
		const setting = new Setting(el)
			.setName('Break length')
			.setDesc('The break after every block. With auto, it depends on the block length (below). The break buttons in the Kiri view change this too. A running break keeps its length.')
			.addDropdown((d) =>
				d
					.addOptions({ auto: 'Auto (by block length)', set: 'Set minutes' })
					.setValue(this.breakAuto ? 'auto' : 'set')
					.onChange((v) => this.plugin.setBreakMinutes(v === 'auto' ? null : this.plugin.autoBreakMinutes())),
			);
		if (this.breakAuto) {
			this.breakSetting(el, 'Break after blocks up to 25 minutes', 'short');
			this.breakSetting(el, 'Break after blocks up to 50 minutes', 'medium');
			this.breakSetting(el, 'Break after longer blocks', 'long');
			return;
		}
		this.numberSetting(
			setting,
			MIN_BREAK_MINUTES,
			MAX_BREAK_MINUTES,
			() => s.breakMinutes ?? this.plugin.autoBreakMinutes(),
			(minutes) => this.plugin.setBreakMinutes(minutes),
		);
		this.breakField = setting.controlEl.querySelector('input');
		this.breakField?.setAttribute('aria-label', `Break minutes (${MIN_BREAK_MINUTES}–${MAX_BREAK_MINUTES})`);
	}

	/** Keep the break length part in step with the panel. */
	private syncBreak(): void {
		const chosen = this.plugin.settings.breakMinutes;
		if ((chosen === null) !== this.breakAuto) {
			this.drawBreak();
			return;
		}
		const field = this.breakField;
		if (field && chosen !== null && activeDocument.activeElement !== field) field.value = String(chosen);
	}

	private breakSetting(parent: HTMLElement, name: string, key: 'short' | 'medium' | 'long'): void {
		const s = this.plugin.settings;
		this.numberSetting(
			new Setting(parent).setName(name).setDesc('Used when break length is auto. Minutes, from 1 to 60.'),
			1,
			60,
			() => s.breaks[key],
			(minutes) => {
				s.breaks[key] = minutes;
				void this.plugin.saveSettings();
			},
		);
	}

	/**
	 * A number field that is applied when it is left or Enter is pressed, not on
	 * every keystroke. The field then shows the value in use (clamped to its
	 * range), with a short message under the setting when the input was changed.
	 */
	private numberSetting(setting: Setting, min: number, max: number, get: () => number, apply: (value: number) => void): void {
		let field: TextComponent | null = null;
		setting.addText((text) => {
			field = text;
			text.setValue(String(get()));
		});
		const message = setting.descEl.createDiv({ cls: 'kiri-field-message' });
		const input = (field as TextComponent | null)?.inputEl;
		if (!input) return;
		input.inputMode = 'numeric';
		input.addEventListener('change', () => {
			const r = readNumberField(input.value, min, max, get());
			input.value = r.text;
			message.setText(r.message ?? '');
			if (r.value !== get()) apply(r.value);
		});
	}
}
