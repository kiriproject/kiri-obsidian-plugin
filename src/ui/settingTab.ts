import {
	type App,
	type ButtonComponent,
	type DropdownComponent,
	Notice,
	PluginSettingTab,
	type Setting,
	type SettingDefinitionItem,
	type SettingGroupItem,
	type TextComponent,
} from 'obsidian';
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

/** One settings row: its name and description (shown and searched) and how to fill it in. */
interface Row {
	name: string;
	desc?: string | DocumentFragment;
	render?: (setting: Setting) => void;
}

/**
 * Kiri's settings, given to Obsidian as definitions (Obsidian 1.13 and later), so they
 * appear in the settings search. Each row is drawn by its own render function. The
 * rows depend on the account, the sounds and the break mode; when one of those changes,
 * the definitions are built again with update().
 */
export class KiriSettingTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;
	/** What the changing parts looked like when the definitions were built. */
	private shapeKey = '';
	private cacheDescEl: HTMLElement | null = null;
	private cacheButton: ButtonComponent | null = null;
	private breakField: HTMLInputElement | null = null;
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
		this.breakField = null;
		this.cacheDescEl = null;
		this.cacheButton = null;
		// A connection that is still waiting keeps going (the browser may be open on top of
		// Obsidian, for example on a phone); its result is shown as a Notice.
		this.plugin.account.resetFlow();
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		this.shapeKey = this.shapeSignature();
		this.lastLoading = this.plugin.soundLoading;
		return [
			this.group(undefined, this.timerRows()),
			this.group('Breaks', this.breakRows()),
			this.group('Sound', this.soundRows()),
			this.group('Focus log', this.logRows()),
			this.group('Tasks', this.taskRows()),
			this.group('Kiri account', this.accountRows()),
		];
	}

	/** Called when a row is drawn: from then on, follow changes made elsewhere (the panel, the account). */
	private watch(): void {
		this.visible = true;
		if (this.unsubscribe) return;
		this.unsubscribe = this.plugin.subscribe((event) => {
			if (event !== 'change') return;
			if (this.shapeSignature() !== this.shapeKey) {
				this.update();
				return;
			}
			if (this.lastLoading !== this.plugin.soundLoading) {
				// A download finished or started: only the size line changes.
				this.lastLoading = this.plugin.soundLoading;
				this.updateCacheSize();
			}
			const chosen = this.plugin.settings.breakMinutes;
			const field = this.breakField;
			if (field && chosen !== null && activeDocument.activeElement !== field) field.value = String(chosen);
		});
	}

	private timerRows(): Row[] {
		const s = this.plugin.settings;
		return [
			{
				name: 'Focus length',
				desc: `Minutes per focus block, from ${MIN_MINUTES} to ${MAX_MINUTES}. The buttons in the Kiri view change this too.`,
				render: (setting) =>
					this.numberField(setting, MIN_MINUTES, MAX_MINUTES, () => s.focusMinutes, (minutes) => this.plugin.setFocusMinutes(minutes)),
			},
			this.toggleRow('Chime', 'Play a soft chime when a focus block or break ends.', () => s.chime, (v) => (s.chime = v)),
			{
				name: 'Chime sound',
				render: (setting) =>
					setting
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
						),
			},
		];
	}

	/**
	 * Break length: Auto (by block length) or set minutes, the same choice as the
	 * Break row in the panel. The three by-length fields are shown only with Auto.
	 */
	private breakRows(): Row[] {
		const s = this.plugin.settings;
		const auto = s.breakMinutes === null;
		const byLength = (name: string, key: 'short' | 'medium' | 'long'): Row =>
			this.numberRow(name, 'Used when break length is auto. Minutes, from 1 to 60.', 1, 60, () => s.breaks[key], (minutes) => {
				s.breaks[key] = minutes;
				void this.plugin.saveSettings();
			});
		return [
			this.toggleRow(
				'Take a break after each block',
				'The sound fades out during the break and fades back in when the next block starts.',
				() => s.breaksEnabled,
				(v) => (s.breaksEnabled = v),
			),
			{
				name: 'Break length',
				desc: 'The break after every block. With auto, it depends on the block length (below). The break buttons in the Kiri view change this too. A running break keeps its length.',
				render: (setting) => {
					this.breakField = null;
					setting.addDropdown((d) =>
						d
							.addOptions({ auto: 'Auto (by block length)', set: 'Set minutes' })
							.setValue(auto ? 'auto' : 'set')
							.onChange((v) => this.plugin.setBreakMinutes(v === 'auto' ? null : this.plugin.autoBreakMinutes())),
					);
					if (auto) return;
					this.numberField(
						setting,
						MIN_BREAK_MINUTES,
						MAX_BREAK_MINUTES,
						() => s.breakMinutes ?? this.plugin.autoBreakMinutes(),
						(minutes) => this.plugin.setBreakMinutes(minutes),
					);
					this.breakField = setting.controlEl.querySelector('input');
					this.breakField?.setAttribute('aria-label', `Break minutes (${MIN_BREAK_MINUTES}–${MAX_BREAK_MINUTES})`);
				},
			},
			...(auto
				? [
						byLength('Break after blocks up to 25 minutes', 'short'),
						byLength('Break after blocks up to 50 minutes', 'medium'),
						byLength('Break after longer blocks', 'long'),
					]
				: []),
			this.toggleRow('Long break', 'Take a longer break after every few blocks.', () => s.longBreakEnabled, (v) => (s.longBreakEnabled = v)),
			this.numberRow('Long break length', 'Minutes, from 1 to 60.', 1, 60, () => s.longBreakMinutes, (minutes) => {
				s.longBreakMinutes = minutes;
				void this.plugin.saveSettings();
			}),
			this.numberRow(
				'Long break every',
				'Number of blocks, from 2 to 12. A gap of two hours starts the count again.',
				2,
				12,
				() => s.longBreakEvery,
				(n) => {
					s.longBreakEvery = n;
					void this.plugin.saveSettings();
				},
			),
			this.toggleRow(
				'Start the break by itself',
				'When off, Kiri waits for you to start the break after a block.',
				() => s.autoStartBreak,
				(v) => (s.autoStartBreak = v),
			),
			this.toggleRow(
				'Start the next block after the break',
				'When off, Kiri waits for you to press start. When on, Kiri still waits after a long break, after 4 blocks in a row started by themselves, and after a break that ended while the device slept.',
				() => s.autoStartNext,
				(v) => (s.autoStartNext = v),
			),
		];
	}

	private soundRows(): Row[] {
		const s = this.plugin.settings;
		const connected = this.plugin.account.connected;
		const rows: Row[] = [
			{
				name: connected ? 'Sound' : 'Noise',
				desc: connected
					? 'Kiri sounds are downloaded the first time you play them, about 15 to 25 MB each, and kept in the plugin folder. Noise is made on your device.'
					: 'Noise made on your device while you focus. Nothing is downloaded.',
				render: (setting) =>
					setting.addDropdown((d) => {
						this.fillSounds(d);
						d.onChange((v) => {
							if (!this.plugin.setSound(v as SoundChoice)) d.setValue(this.plugin.settings.sound);
						});
					}),
			},
			{
				name: 'Volume',
				render: (setting) =>
					setting.addSlider((sl) =>
						sl
							.setLimits(0, 100, 1)
							.setValue(s.volume)
							.onChange((v) => this.plugin.setVolume(v)),
					),
			},
		];

		if (connected) {
			rows.push({
				name: 'Downloaded sounds',
				desc: 'Checking…',
				render: (setting) => {
					setting.addButton((b) => {
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
					this.cacheDescEl = setting.descEl;
					this.updateCacheSize();
				},
			});
		}

		if (this.plugin.binauralAllowed()) {
			rows.push(
				{
					name: 'Binaural beats',
					desc:
						this.plugin.account.info?.binaural === 'alpha'
							? 'Two steady tones, one in each ear, a few hertz apart. Made on your device. Use headphones. Your Kiri account includes the Alpha beat.'
							: 'Two steady tones, one in each ear, a few hertz apart. Made on your device. Use headphones.',
					render: (setting) =>
						setting.addDropdown((d) =>
							d
								.addOptions(this.plugin.binauralOptions())
								.setValue(this.plugin.beatAllowed(s.binaural) ? s.binaural : 'off')
								.onChange((v) => this.plugin.setBinaural(v as BinauralChoice)),
						),
				},
				{
					name: 'Binaural volume',
					desc: 'Kept quiet: even at the top of the slider the tones stay soft.',
					render: (setting) =>
						setting.addSlider((sl) =>
							sl
								.setLimits(0, 100, 1)
								.setValue(s.binauralVolume)
								.onChange((v) => this.plugin.setBinauralVolume(v)),
						),
				},
			);
		}
		return rows;
	}

	private logRows(): Row[] {
		const s = this.plugin.settings;
		const daily = readDailyNotesConfig(this.app);
		return [
			this.toggleRow(
				'Log each block',
				daily.enabled
					? "Add a line to today's daily note when a focus block ends. Uses the folder, date format and template of the Daily notes core plugin."
					: `The Daily notes core plugin is off, so lines go to "${FALLBACK_LOG_NOTE}" in the vault root. Turn on Daily notes to log to today's note instead.`,
				() => s.logToDailyNote,
				(v) => (s.logToDailyNote = v),
			),
			this.toggleRow(
				'Create the daily note if it is missing',
				`Off: when today's daily note does not exist yet, the line goes to "${FALLBACK_LOG_NOTE}" and Kiri says so. This way Kiri never makes a second "today" note before a sync service brings the one you wrote on another device. On: Kiri creates the note from your Daily notes template (never an empty note when the template cannot be found).`,
				() => s.createDailyNote,
				(v) => (s.createDailyNote = v),
			),
			{
				name: 'Log heading',
				desc: 'Lines go under this heading. It is added if the note does not have it.',
				render: (setting) =>
					setting.addText((text) =>
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
					),
			},
		];
	}

	private taskRows(): Row[] {
		const s = this.plugin.settings;
		return [
			this.toggleRow(
				'Count blocks on the task',
				'Add or update a [kiri:: 2] field on the task line after each block. Dataview can read it.',
				() => s.taskCounter,
				(v) => (s.taskCounter = v),
			),
			this.toggleRow(
				'Add time spent to the task',
				'After each block, add its minutes to a [spent:: 1h 15m] field on the task line. Add [planned:: 2h] yourself to see planned against spent in the Kiri view. Tasks plugin dates stay at the end of the line. A spent field you already use is read as time (a plain number as minutes) and rewritten, for example [spent:: 20] becomes [spent:: 45m]; a value Kiri cannot read is left alone.',
				() => s.writeSpent,
				(v) => (s.writeSpent = v),
			),
			this.toggleRow(
				'Ask to mark the task done',
				'After each block, ask whether to mark the task done. Uses the Tasks plugin if it is on.',
				() => s.askMarkDone,
				(v) => (s.askMarkDone = v),
			),
			this.toggleRow(
				'Keep the Today list across days',
				'When off, the Today list in the Kiri view starts empty each day at midnight.',
				() => s.keepToday,
				(v) => (s.keepToday = v),
			),
		];
	}

	private accountRows(): Row[] {
		const { plugin } = this;
		const { account } = plugin;
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
			const rows: Row[] = [
				{
					name: info.name ? `Connected as ${info.name}` : 'Connected',
					desc: [info.emailHint, plan].filter(Boolean).join(' · '),
					render: (setting) =>
						setting
							.addButton((b) =>
								b.setButtonText('Refresh').onClick(async () => {
									b.setDisabled(true);
									await account.refresh();
									b.setDisabled(false);
								}),
							)
							.addButton((b) =>
								b.setButtonText('Disconnect').onClick(async () => {
									b.setDisabled(true);
									await plugin.disconnectAccount();
									new Notice('Kiri account disconnected.');
								}),
							),
				},
			];
			if (plugin.hasLockedSounds()) {
				rows.push({
					name: 'More sounds',
					desc: createFragment((f) => {
						f.appendText('Sounds marked locked need a paid Kiri account. ');
						f.createEl('a', { text: 'See plans', href: PRICING_URL });
					}),
				});
			}
			rows.push(
				this.toggleRow(
					'Send finished blocks to Kiri',
					'Adds each finished block to your Kiri history: start time, length, sound and task text (up to 200 characters).',
					() => plugin.settings.syncEnabled,
					(v) => (plugin.settings.syncEnabled = v),
				),
			);
			if (account.pendingCount > 0) {
				const n = account.pendingCount;
				rows.push({
					name: n === 1 ? '1 block waiting to be sent' : `${n} blocks waiting to be sent`,
					desc: 'Kiri tries again at startup and after your next block.',
					render: (setting) =>
						setting
							.addButton((b) => b.setButtonText('Send now').onClick(() => void account.flush()))
							.addButton((b) => b.setButtonText('Clear').onClick(() => void account.clearQueue())),
				});
			}
			rows.push({
				name: 'Connection key',
				desc: `${TOKEN_PLACE_TEXT[account.tokenPlace ?? 'vault']} Disconnect removes it here and on Kiri. You can also remove it on project-kiri.com under connected apps.`,
			});
			return rows;
		}

		const flow = account.flowState;
		if (flow.step === 'starting') {
			return [
				{
					name: 'Connecting…',
					render: (setting) => setting.addButton((b) => b.setButtonText('Cancel').onClick(() => account.cancelConnect())),
				},
			];
		}

		if (flow.step === 'waiting') {
			return [
				{
					name: 'Check the code in your browser',
					desc: 'A Kiri page opened in your browser. Sign in if asked, check that it shows this code, then click allow. You can close settings meanwhile; Kiri keeps waiting until the code expires.',
					render: (setting) => {
						setting
							.addButton((b) => b.setButtonText('Open the page again').onClick(() => window.open(flow.verificationUrl)))
							.addButton((b) => b.setButtonText('Cancel').onClick(() => account.cancelConnect()));
						setting.descEl.createDiv({ cls: 'kiri-user-code', text: flow.userCode });
					},
				},
			];
		}

		const problem =
			flow.step === 'denied'
				? 'The connection was not allowed.'
				: flow.step === 'expired'
					? 'The code expired before it was used.'
					: flow.step === 'error'
						? flow.message
						: '';
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
		return [
			{
				name: 'Connect a Kiri account',
				desc:
					problem ||
					'Optional. Use your Kiri sounds here and add finished blocks to your Kiri history, where they also count kiris. Once connected, each finished block is sent to Kiri with its task text (up to 200 characters), start time, length and sound; you can turn that off in this section. Everything else works without an account.',
				render: (setting) =>
					setting.addButton((b) =>
						b
							.setButtonText(problem ? 'Try again' : 'Connect')
							.setCta()
							.onClick(connect),
					),
			},
		];
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

	/** Everything that changes which rows exist or what they say. */
	private shapeSignature(): string {
		const { account, settings } = this.plugin;
		const f = account.flowState;
		return JSON.stringify([
			settings.breakMinutes === null,
			account.connected,
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

	private fillSounds(d: DropdownComponent): void {
		for (const option of this.plugin.soundOptions()) d.addOption(option.value, option.label);
		d.setValue(this.plugin.settings.sound);
	}

	private toggleRow(name: string, desc: string, get: () => boolean, set: (value: boolean) => void): Row {
		return {
			name,
			desc,
			render: (setting) =>
				setting.addToggle((t) =>
					t.setValue(get()).onChange(async (v) => {
						set(v);
						await this.plugin.saveSettings();
					}),
				),
		};
	}

	private numberRow(name: string, desc: string, min: number, max: number, get: () => number, apply: (value: number) => void): Row {
		return { name, desc, render: (setting) => this.numberField(setting, min, max, get, apply) };
	}

	/**
	 * A number field that is applied when it is left or Enter is pressed, not on
	 * every keystroke. The field then shows the value in use (clamped to its
	 * range), with a short message under the setting when the input was changed.
	 */
	private numberField(setting: Setting, min: number, max: number, get: () => number, apply: (value: number) => void): void {
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

	/** A group of rows under a heading (none for the first group). */
	private group(heading: string | undefined, rows: Row[]): SettingDefinitionItem {
		return { type: 'group', heading, items: rows.map((row) => this.definition(row)) };
	}

	/** Turn a row into a definition: Obsidian shows its name and description, the row adds its controls. */
	private definition(row: Row): SettingGroupItem {
		return {
			name: row.name,
			desc: row.desc,
			render: (setting) => {
				this.watch();
				setting.setName(row.name);
				if (row.desc !== undefined) setting.setDesc(row.desc);
				row.render?.(setting);
			},
		};
	}
}
