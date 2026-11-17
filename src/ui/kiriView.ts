import {
	ButtonComponent,
	debounce,
	DropdownComponent,
	ItemView,
	setIcon,
	SliderComponent,
	TFile,
	ToggleComponent,
	type WorkspaceLeaf,
} from 'obsidian';
import type KiriPlugin from '../main';
import type { KiriEvent } from '../main';
import { blockInCycle } from '../logic/cycle';
import { BREAK_PRESETS, clampMinutes, formatCountdown, MAX_BREAK_MINUTES, MAX_MINUTES, MIN_BREAK_MINUTES, MIN_MINUTES, PRESET_LENGTHS, readNumberField } from '../logic/duration';
import { formatDurationText, readPlanned, readSpent } from '../logic/taskLine';
import { indexOfTask, MAX_TODAY } from '../logic/today';
import { focusTarget, isDisabledControl, isTodayControl, type TodayFocus } from './todayFocus';
import { controlsLayout, taskListSignature } from './viewSignature';
import { formatKiris, PRICING_URL } from '../account/api';
import type { SoundChoice } from '../settings';
import { matchesQuery, openTasksInFile, openTasksInVault, TaskCache, type TaskItem } from '../vault/tasks';

export const KIRI_VIEW_TYPE = 'kiri-focus-timer-view';
const SITE_URL = 'https://project-kiri.com';
const MAX_SHOWN_TASKS = 50;
/** Numbers each Kiri view, so element ids stay unique with two views open. */
let viewCount = 0;

export class KiriView extends ItemView {
	private allNotes = false;
	private query = '';
	private tasks: TaskItem[] = [];
	private capped = false;
	private loadToken = 0;
	/** Open tasks per note for "All notes", so typing a filter reads no notes again. */
	private readonly taskCache = new TaskCache();

	private todayLabelEl!: HTMLElement;
	private todayListEl!: HTMLElement;
	private todayHintEl!: HTMLElement;
	/** Screen reader announcements for Today actions (moves, removals, ticks). */
	private todayLiveEl!: HTMLElement;
	/** The Today items last drawn, so the list is only rebuilt when they change. */
	private todayDrawn: string | null = null;
	/** The Today item being dragged; looked up again on drop, as the list may have been redrawn. */
	private dragTask: { path: string; raw: string } | null = null;
	/** Where keyboard focus goes when the list is next rebuilt (after a move, removal or tick). */
	private focusAfterRender: TodayFocus | null = null;
	private countdownEl!: HTMLElement;
	private phaseEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private selectedEl!: HTMLElement;
	private taskListEl!: HTMLElement;
	private lengthEl!: HTMLElement;
	private controlsEl!: HTMLElement;
	/** Which set of timer buttons is drawn; see renderControls. */
	private controlsLayout = '';
	private pauseButton: ButtonComponent | null = null;
	/** What the task list last drew; see renderTaskList. */
	private taskListDrawn = '';
	private customInput!: HTMLInputElement;
	private breakSection!: HTMLElement;
	private breakEl!: HTMLElement;
	private breakAutoButton!: HTMLButtonElement;
	private breakInput!: HTMLInputElement;
	private breakMessageEl!: HTMLElement;
	private soundDropdown!: DropdownComponent;
	private volumeSlider!: SliderComponent;
	private soundStatusEl!: HTMLElement;
	private kirisEl!: HTMLElement;
	/** The sound options last put in the dropdown, to rebuild it only when they change. */
	private soundKey = '';
	private unsubscribe: (() => void) | null = null;

	private readonly refreshTasksSoon = debounce(() => void this.loadTasks(), 400, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: KiriPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return KIRI_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Kiri';
	}

	getIcon(): string {
		return 'timer';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('kiri-view');
		this.todayDrawn = null;
		this.controlsLayout = '';
		this.taskListDrawn = '';

		// Today
		const todaySection = root.createDiv({ cls: 'kiri-section kiri-today' });
		// Focusable from script only: focus lands here when the last task leaves the list.
		const labelId = `kiri-today-label-${++viewCount}`;
		this.todayLabelEl = todaySection.createDiv({ cls: 'kiri-label', text: 'Today', attr: { id: labelId, tabindex: '-1' } });
		this.todayListEl = todaySection.createDiv({ cls: 'kiri-today-list', attr: { role: 'list', 'aria-labelledby': labelId } });
		this.todayHintEl = todaySection.createDiv({ cls: 'kiri-muted kiri-today-hint' });
		this.todayLiveEl = todaySection.createDiv({ cls: 'kiri-sr-only', attr: { 'aria-live': 'polite' } });

		// Timer
		const timerEl = root.createDiv({ cls: 'kiri-timer' });
		this.phaseEl = timerEl.createDiv({ cls: 'kiri-phase' });
		this.countdownEl = timerEl.createDiv({ cls: 'kiri-countdown' });
		this.hintEl = timerEl.createDiv({ cls: 'kiri-hint' });
		this.controlsEl = timerEl.createDiv({ cls: 'kiri-controls' });

		// Length
		const lengthSection = root.createDiv({ cls: 'kiri-section' });
		lengthSection.createDiv({ cls: 'kiri-label', text: 'Length' });
		this.lengthEl = lengthSection.createDiv({ cls: 'kiri-lengths' });
		this.buildLengths();

		// Break (hidden while breaks are off in the settings)
		this.breakSection = root.createDiv({ cls: 'kiri-section' });
		const breakLabelId = `kiri-break-label-${viewCount}`;
		this.breakSection.createDiv({ cls: 'kiri-label', text: 'Break', attr: { id: breakLabelId } });
		this.breakEl = this.breakSection.createDiv({ cls: 'kiri-lengths', attr: { role: 'group', 'aria-labelledby': breakLabelId } });
		this.breakMessageEl = this.breakSection.createDiv({ cls: 'kiri-muted kiri-field-message', attr: { 'aria-live': 'polite' } });
		this.buildBreaks();

		// Task
		const taskSection = root.createDiv({ cls: 'kiri-section' });
		taskSection.createDiv({ cls: 'kiri-label', text: 'Task' });
		this.selectedEl = taskSection.createDiv({ cls: 'kiri-selected' });
		const searchRow = taskSection.createDiv({ cls: 'kiri-row' });
		const search = searchRow.createEl('input', {
			cls: 'kiri-search',
			attr: { type: 'search', placeholder: 'Filter tasks', 'aria-label': 'Filter tasks' },
		});
		this.registerDomEvent(search, 'input', () => {
			this.query = search.value;
			if (this.allNotes) this.refreshTasksSoon();
			else this.renderTaskList();
		});
		const scope = searchRow.createDiv({ cls: 'kiri-scope' });
		scope.createSpan({ text: 'All notes' });
		new ToggleComponent(scope)
			.setValue(this.allNotes)
			.setTooltip('Show open tasks from all notes')
			.onChange((value) => {
				this.allNotes = value;
				void this.loadTasks();
			});
		this.taskListEl = taskSection.createDiv({ cls: 'kiri-task-list' });

		// Sound
		const soundSection = root.createDiv({ cls: 'kiri-section' });
		soundSection.createDiv({ cls: 'kiri-label', text: 'Sound' });
		const soundRow = soundSection.createDiv({ cls: 'kiri-row' });
		this.soundDropdown = new DropdownComponent(soundRow).onChange((value) => {
			if (!this.plugin.setSound(value as SoundChoice)) this.soundDropdown.setValue(this.plugin.settings.sound);
		});
		this.soundDropdown.selectEl.setAttribute('aria-label', 'Sound');
		this.volumeSlider = new SliderComponent(soundRow)
			.setLimits(0, 100, 1)
			.setValue(this.plugin.settings.volume)
			.onChange((value) => this.plugin.setVolume(value));
		this.volumeSlider.sliderEl.setAttribute('aria-label', 'Volume');
		this.soundStatusEl = soundSection.createDiv({ cls: 'kiri-sound-status' });

		// Stats
		const statsRow = root.createDiv({ cls: 'kiri-row' });
		new ButtonComponent(statsRow).setButtonText('Focus stats').onClick(() => this.plugin.openStats());

		// Footer
		const footer = root.createDiv({ cls: 'kiri-footer' });
		this.kirisEl = footer.createDiv({ cls: 'kiri-kiris' });
		footer.appendText('More sounds and your full history: ');
		footer.createEl('a', { text: 'project-kiri.com', href: SITE_URL });

		// Events
		this.unsubscribe = this.plugin.subscribe((event) => this.onPluginEvent(event));
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				if (!this.allNotes) void this.loadTasks();
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				// Only this note is read again on the next scan; the others come from the cache.
				this.taskCache.invalidate(file.path);
				if (this.allNotes || file.path === this.app.workspace.getActiveFile()?.path) this.refreshTasksSoon();
			}),
		);
		const forgetAll = (): void => {
			// Rare: a renamed folder moves many notes at once, so start the cache again.
			this.taskCache.clear();
			if (this.allNotes) this.refreshTasksSoon();
		};
		this.registerEvent(this.app.vault.on('rename', forgetAll));
		this.registerEvent(this.app.vault.on('delete', forgetAll));

		this.render();
		await this.loadTasks();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.refreshTasksSoon.cancel();
		this.loadToken++; // Stops a scan still running.
		this.taskCache.clear();
		this.contentEl.empty();
	}

	private onPluginEvent(event: KiriEvent): void {
		if (event === 'tick') this.renderCountdown();
		else this.render();
	}

	private render(): void {
		this.renderToday();
		this.renderCountdown();
		this.renderControls();
		this.renderLengths();
		this.renderBreaks();
		this.renderSelected();
		this.renderTaskList();
		this.renderSound();
		this.renderKiris();
	}

	/** The account's kiri total, only when connected and the server sent one. */
	private renderKiris(): void {
		const total = this.plugin.kirisTotal();
		this.kirisEl.setText(total === null ? '' : `On your Kiri account: ${formatKiris(total)}`);
	}

	private renderSound(): void {
		// The list changes when a Kiri account is connected or its plan changes.
		const options = this.plugin.soundOptions();
		const key = JSON.stringify(options);
		if (key !== this.soundKey) {
			this.soundKey = key;
			this.soundDropdown.selectEl.empty();
			for (const option of options) this.soundDropdown.addOption(option.value, option.label);
		}
		// Keep in step with changes made in the settings tab.
		const { sound, volume } = this.plugin.settings;
		if (this.soundDropdown.getValue() !== sound) this.soundDropdown.setValue(sound);
		if (this.volumeSlider.getValue() !== volume) this.volumeSlider.setValue(volume);

		const status = this.soundStatusEl;
		status.empty();
		if (this.plugin.soundLoading) {
			const label = options.find((o) => o.value === `kiri:${this.plugin.soundLoading}`)?.label ?? 'sound';
			status.createSpan({ cls: 'kiri-muted', text: `Loading ${label}…` });
		} else if (this.plugin.hasLockedSounds()) {
			const line = status.createSpan({ cls: 'kiri-muted' });
			line.appendText('Locked sounds need a paid Kiri account. ');
			line.createEl('a', { text: 'See plans', href: PRICING_URL });
		}
	}

	private renderCountdown(): void {
		const { phase, running } = this.plugin.timer;
		this.countdownEl.setText(formatCountdown(this.plugin.remaining()));
		this.countdownEl.toggleClass('is-paused', phase !== 'idle' && !running);
		let label = phase === 'focus' ? 'Focus' : phase === 'break' ? (this.plugin.longBreak ? 'Long break' : 'Break') : 'Ready';
		const s = this.plugin.settings;
		if (phase === 'focus' && s.breaksEnabled && s.longBreakEnabled) {
			// The running block is not counted yet, so it is the next one in the cycle.
			label += ` · ${blockInCycle(this.plugin.cycle, s.longBreakEvery, Date.now())} of ${s.longBreakEvery}`;
		}
		this.phaseEl.setText(phase !== 'idle' && !running ? `${label} (paused)` : label);
		this.hintEl.setText(this.plugin.hint);
	}

	/**
	 * The timer buttons. They are rebuilt only when the set of buttons changes
	 * (idle, waiting break, focus, break); otherwise only the Pause/Resume text
	 * changes, so a keyboard user who pressed Pause keeps focus on it.
	 */
	private renderControls(): void {
		const el = this.controlsEl;
		const { phase, running } = this.plugin.timer;
		const pending = this.plugin.pendingBreak;
		const layout = controlsLayout(phase, pending);
		if (layout === this.controlsLayout) {
			this.pauseButton?.setButtonText(running ? 'Pause' : 'Resume');
			return;
		}
		const focused = activeDocument.activeElement;
		const focusedIndex = focused?.instanceOf(HTMLElement) && el.contains(focused) ? Array.from(el.children).indexOf(focused) : -1;
		this.controlsLayout = layout;
		this.pauseButton = null;
		el.empty();
		if (phase === 'idle' && pending) {
			new ButtonComponent(el)
				.setButtonText(pending.isLong ? 'Start long break' : 'Start break')
				.setCta()
				.onClick(() => this.plugin.startBreak());
			new ButtonComponent(el).setButtonText('Start next block').onClick(() => this.plugin.startFocus());
		} else if (phase === 'idle') {
			new ButtonComponent(el)
				.setButtonText('Start')
				.setCta()
				.onClick(() => this.plugin.startFocus());
		} else {
			this.pauseButton = new ButtonComponent(el).setButtonText(running ? 'Pause' : 'Resume').onClick(() => this.plugin.togglePause());
			if (phase === 'break') {
				new ButtonComponent(el)
					.setButtonText('Start next block')
					.setCta()
					.onClick(() => this.plugin.startFocus());
				new ButtonComponent(el).setButtonText('Skip break').onClick(() => this.plugin.skipBreak());
			} else {
				new ButtonComponent(el).setButtonText('Stop').onClick(() => this.plugin.stop());
			}
		}
		// The buttons changed under the keyboard (Start became Pause, Stop became Start): keep focus in the same place.
		if (focusedIndex !== -1) {
			const buttons = Array.from(el.children);
			const target = buttons[Math.min(focusedIndex, buttons.length - 1)];
			if (target?.instanceOf(HTMLElement)) target.focus();
		}
	}

	private buildLengths(): void {
		for (const minutes of PRESET_LENGTHS) {
			const btn = this.lengthEl.createEl('button', { cls: 'kiri-length', text: String(minutes) });
			btn.dataset.minutes = String(minutes);
			btn.setAttribute('aria-label', `${minutes} minutes`);
			this.registerDomEvent(btn, 'click', () => this.plugin.setFocusMinutes(minutes));
		}
		this.customInput = this.lengthEl.createEl('input', {
			cls: 'kiri-custom',
			attr: {
				type: 'number',
				min: String(MIN_MINUTES),
				max: String(MAX_MINUTES),
				step: '1',
				placeholder: 'Min',
				'aria-label': `Custom minutes (${MIN_MINUTES}–${MAX_MINUTES})`,
			},
		});
		this.registerDomEvent(this.customInput, 'change', () => {
			const minutes = clampMinutes(this.customInput.value);
			if (minutes === null) {
				this.renderLengths();
				return;
			}
			this.customInput.value = String(minutes);
			this.plugin.setFocusMinutes(minutes);
		});
	}

	private renderLengths(): void {
		const current = this.plugin.settings.focusMinutes;
		const locked = this.plugin.timer.phase !== 'idle';
		this.lengthEl.querySelectorAll<HTMLButtonElement>('button.kiri-length').forEach((btn) => {
			const active = btn.dataset.minutes === String(current);
			btn.toggleClass('is-active', active);
			btn.setAttribute('aria-pressed', String(active));
			btn.disabled = locked;
		});
		const isPreset = (PRESET_LENGTHS as readonly number[]).includes(current);
		this.customInput.disabled = locked;
		this.customInput.toggleClass('is-active', !isPreset);
		if (activeDocument.activeElement !== this.customInput) {
			this.customInput.value = isPreset ? '' : String(current);
		}
	}

	/**
	 * The break row: Auto (by block length), presets and custom minutes. Never
	 * locked: a running break keeps its length and the choice applies from the next one.
	 */
	private buildBreaks(): void {
		this.breakAutoButton = this.breakEl.createEl('button', { cls: 'kiri-length kiri-break-auto' });
		this.breakAutoButton.dataset.minutes = 'auto';
		this.registerDomEvent(this.breakAutoButton, 'click', () => this.setBreak(null));
		for (const minutes of BREAK_PRESETS) {
			const btn = this.breakEl.createEl('button', { cls: 'kiri-length', text: String(minutes) });
			btn.dataset.minutes = String(minutes);
			btn.setAttribute('aria-label', `${minutes} minute break`);
			this.registerDomEvent(btn, 'click', () => this.setBreak(minutes));
		}
		this.breakInput = this.breakEl.createEl('input', {
			cls: 'kiri-custom',
			attr: {
				type: 'number',
				min: String(MIN_BREAK_MINUTES),
				max: String(MAX_BREAK_MINUTES),
				step: '1',
				placeholder: 'Min',
				'aria-label': `Custom break minutes (${MIN_BREAK_MINUTES}–${MAX_BREAK_MINUTES})`,
			},
		});
		this.registerDomEvent(this.breakInput, 'change', () => {
			const chosen = this.plugin.settings.breakMinutes;
			// An emptied field (or text that is not a number) keeps the choice as it is.
			if (clampMinutes(this.breakInput.value, MIN_BREAK_MINUTES, MAX_BREAK_MINUTES) === null) {
				this.breakMessageEl.setText(this.breakInput.value.trim() ? `Enter a number from ${MIN_BREAK_MINUTES} to ${MAX_BREAK_MINUTES}.` : '');
				this.breakInput.value = '';
				this.renderBreaks();
				return;
			}
			const r = readNumberField(this.breakInput.value, MIN_BREAK_MINUTES, MAX_BREAK_MINUTES, chosen ?? this.plugin.autoBreakMinutes());
			this.breakMessageEl.setText(r.message ?? '');
			this.breakInput.value = r.text;
			this.plugin.setBreakMinutes(r.value);
		});
	}

	private setBreak(minutes: number | null): void {
		this.breakMessageEl.setText('');
		this.plugin.setBreakMinutes(minutes);
	}

	private renderBreaks(): void {
		const s = this.plugin.settings;
		this.breakSection.toggle(s.breaksEnabled);
		const chosen = s.breakMinutes;
		const auto = this.plugin.autoBreakMinutes();
		this.breakAutoButton.setText(`Auto · ${auto}`);
		this.breakAutoButton.setAttribute('aria-label', `Auto: ${auto} minute break, set by block length`);
		this.breakEl.querySelectorAll<HTMLButtonElement>('button.kiri-length').forEach((btn) => {
			const active = btn.dataset.minutes === (chosen === null ? 'auto' : String(chosen));
			btn.toggleClass('is-active', active);
			btn.setAttribute('aria-pressed', String(active));
		});
		const isCustom = chosen !== null && !(BREAK_PRESETS as readonly number[]).includes(chosen);
		this.breakInput.toggleClass('is-active', isCustom);
		if (activeDocument.activeElement !== this.breakInput) {
			this.breakInput.value = isCustom ? String(chosen) : '';
		}
	}

	private renderSelected(): void {
		const el = this.selectedEl;
		el.empty();
		const task = this.plugin.task;
		if (!task) {
			el.createSpan({ cls: 'kiri-muted', text: 'No task picked. Pick one below, or just start.' });
			return;
		}
		const fromToday = this.plugin.today.items.length > 0;
		const textEl = el.createDiv({ cls: 'kiri-selected-text' });
		textEl.createSpan({ text: task.text });
		textEl.createSpan({ cls: 'kiri-note-name', text: fromToday ? `${task.noteName} · first on Today` : task.noteName });
		const spent = readSpent(task.raw);
		const planned = readPlanned(task.raw);
		if (spent > 0 || planned !== null) {
			const parts = [`Spent ${formatDurationText(spent)}`];
			if (planned !== null) parts.push(`of ${formatDurationText(planned)} planned`);
			textEl.createSpan({ cls: 'kiri-note-name', text: parts.join(' ') });
		}
		// A task from Today leaves through the Today list (tick or remove).
		if (fromToday) return;
		new ButtonComponent(el)
			.setIcon('x')
			.setTooltip('Clear task')
			.setClass('clickable-icon')
			.onClick(() => this.plugin.selectTask(null));
	}

	/**
	 * Draw the Today list. It is rebuilt only when its items changed, so focus
	 * and scroll stay put on unrelated redraws (volume, account, sound loading).
	 * When it is rebuilt, focus goes to the same control on the same row (or
	 * where focusAfterRender says), or to the "Today" heading when the list is empty.
	 */
	private renderToday(): void {
		const items = this.plugin.today.items;
		const drawn = JSON.stringify(items);
		if (drawn === this.todayDrawn) return;
		this.todayDrawn = drawn;

		const el = this.todayListEl;
		const focus = this.focusAfterRender ?? this.focusedTodayControl();
		this.focusAfterRender = null;
		const scrollTop = el.scrollTop;
		el.empty();
		this.todayLabelEl.setText(items.length > 0 ? `Today · ${items.length}` : 'Today');
		el.toggleClass('kiri-hidden', items.length === 0);
		this.todayHintEl.setText(
			items.length === 0
				? 'Plan your day: add tasks with + in the list below. The first one is the task you focus on.'
				: items.length >= MAX_TODAY
					? `Today is full (${MAX_TODAY} tasks).`
					: '',
		);

		items.forEach((task, index) => {
			const row = el.createDiv({ cls: 'kiri-today-item', attr: { role: 'listitem', draggable: 'true' } });
			row.dataset.index = String(index);
			row.toggleClass('is-current', index === 0);
			row.toggleClass('is-stale', !!task.stale);
			const words = task.text;

			const box = row.createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox', 'aria-label': `Done: ${words}` } });
			box.dataset.control = 'done';
			box.addEventListener('change', () => {
				box.disabled = true;
				this.focusAfterRender = { index, control: 'done' };
				void this.plugin.completeTodayItem(task).then((done) => {
					if (done) {
						this.announce(`Done: ${words}`);
						return;
					}
					// Nothing changed, so nothing is redrawn: give the checkbox back.
					this.focusAfterRender = null;
					box.checked = false;
					box.disabled = false;
					box.focus();
				});
			});

			// The task's words: click (or Enter or Space) to make it the current task.
			const text = row.createDiv({ cls: 'kiri-today-text' });
			text.dataset.control = 'pick';
			text.setAttribute('role', 'button');
			text.setAttribute('tabindex', '0');
			text.setAttribute('aria-label', index === 0 ? `Current task: ${words}` : `Make current: ${words}`);
			if (index === 0) text.setAttribute('aria-current', 'true');
			text.createSpan({ text: words });
			const where = index === 0 ? `${task.noteName} · now` : task.noteName;
			text.createSpan({ cls: 'kiri-note-name', text: task.stale ? `${where} · not found in the note` : where });
			const pick = (): void => {
				if (index === 0) return;
				this.focusAfterRender = { index: 0, control: 'pick' };
				if (this.plugin.selectTask(task)) this.announce(`Now current: ${words}`);
				else this.focusAfterRender = null;
			};
			text.addEventListener('click', pick);
			text.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter' || evt.key === ' ') {
					evt.preventDefault();
					pick();
				}
			});

			const actions = row.createDiv({ cls: 'kiri-today-actions' });
			if (index === 0) {
				this.iconButton(actions, 'skip-forward', 'Next task (this one goes to the end of Today)', items.length < 2, () => {
					this.focusAfterRender = { index: 0, control: 'next' };
					if (this.plugin.nextTask()) {
						const next = this.plugin.today.items[0];
						this.announce(next ? `Now current: ${next.text}. Moved to the end: ${words}` : `Moved to the end: ${words}`);
					} else {
						this.focusAfterRender = null;
					}
				}).dataset.control = 'next';
			}
			this.iconButton(actions, 'chevron-up', 'Move up', index === 0, () => {
				this.focusAfterRender = { index: index - 1, control: 'up' };
				this.plugin.moveTodayItem(index, index - 1);
				this.announce(`Moved to position ${index} of ${items.length}`);
			}).dataset.control = 'up';
			this.iconButton(actions, 'chevron-down', 'Move down', index === items.length - 1, () => {
				this.focusAfterRender = { index: index + 1, control: 'down' };
				this.plugin.moveTodayItem(index, index + 1);
				this.announce(`Moved to position ${index + 2} of ${items.length}`);
			}).dataset.control = 'down';
			this.iconButton(actions, 'x', 'Remove from Today', false, () => {
				this.focusAfterRender = { index, control: 'remove' };
				this.plugin.removeTodayItem(index);
				this.announce(`Removed from the list: ${words}`);
			}).dataset.control = 'remove';

			// Drag and drop to reorder (the buttons do the same from the keyboard).
			row.addEventListener('dragstart', (evt) => {
				this.dragTask = { path: task.path, raw: task.raw };
				evt.dataTransfer?.setData('text/plain', words);
				if (evt.dataTransfer) evt.dataTransfer.effectAllowed = 'move';
				row.addClass('is-dragging');
			});
			row.addEventListener('dragend', () => {
				this.dragTask = null;
				row.removeClass('is-dragging');
				el.querySelectorAll('.is-drop-target').forEach((n) => n.removeClass('is-drop-target'));
			});
			row.addEventListener('dragover', (evt) => {
				if (this.dragTask === null) return;
				evt.preventDefault();
				if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
				row.addClass('is-drop-target');
			});
			row.addEventListener('dragleave', () => row.removeClass('is-drop-target'));
			row.addEventListener('drop', (evt) => {
				evt.preventDefault();
				const dragged = this.dragTask;
				this.dragTask = null;
				if (!dragged) return;
				// Indexes from now, not from when the drag started.
				const current = this.plugin.today.items;
				const from = indexOfTask(current, dragged);
				const to = indexOfTask(current, task);
				if (from !== -1 && to !== -1 && from !== to) this.plugin.moveTodayItem(from, to);
			});
		});

		el.scrollTop = scrollTop;
		if (focus) this.restoreTodayFocus(focus, items.length);
	}

	/** The Today control that has keyboard focus now, if any. */
	private focusedTodayControl(): TodayFocus | null {
		const active = activeDocument.activeElement;
		if (!active?.instanceOf(HTMLElement) || !this.todayListEl.contains(active)) return null;
		const control = active.dataset.control;
		const row = active.closest<HTMLElement>('.kiri-today-item');
		if (!row || !isTodayControl(control)) return null;
		return { index: Number(row.dataset.index ?? 0), control };
	}

	/** Focus a control on the row now at `focus.index` (or the last row), or the heading when the list is empty. */
	private restoreTodayFocus(focus: TodayFocus, count: number): void {
		const target = focusTarget(focus, count, (index, control) => isDisabledControl(index, count, control));
		if (target === 'heading') this.todayLabelEl.focus();
		else if (target) this.todayListEl.querySelector<HTMLElement>(`.kiri-today-item[data-index="${target.index}"] [data-control="${target.control}"]`)?.focus();
	}

	/** Say something to screen readers without moving focus. */
	private announce(message: string): void {
		this.todayLiveEl.setText('');
		window.setTimeout(() => this.todayLiveEl.setText(message), 50);
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
		const btn = parent.createEl('button', { cls: 'clickable-icon kiri-icon-button', attr: { 'aria-label': label } });
		setIcon(btn, icon);
		btn.disabled = disabled;
		btn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			onClick();
		});
		return btn;
	}

	private async loadTasks(): Promise<void> {
		const token = ++this.loadToken;
		const isStale = (): boolean => token !== this.loadToken;
		let tasks: TaskItem[] = [];
		let capped = false;
		if (this.allNotes) {
			const result = await openTasksInVault(this.app, this.query, { cache: this.taskCache, isStale });
			if (!result) return; // A newer scan started meanwhile.
			tasks = result.tasks;
			capped = result.capped;
		} else {
			const file = this.app.workspace.getActiveFile();
			if (file instanceof TFile && file.extension === 'md') tasks = await openTasksInFile(this.app, file);
		}
		if (token !== this.loadToken) return; // A newer load started meanwhile.
		this.tasks = tasks;
		this.capped = capped;
		this.renderTaskList();
	}

	/**
	 * Draw the task list. It is rebuilt only when what it shows changed (tasks,
	 * filter, selection, Today marks); after a rebuild, keyboard focus goes back
	 * to the same control on the same row.
	 */
	private renderTaskList(): void {
		const el = this.taskListEl;
		if (!el) return;
		const shown = this.tasks.filter((t) => matchesQuery(t, this.query)).slice(0, MAX_SHOWN_TASKS);
		const selected = this.plugin.task;
		const activeFile = this.app.workspace.getActiveFile()?.path ?? '';
		const drawn = taskListSignature({
			allNotes: this.allNotes,
			capped: this.capped,
			total: this.tasks.length,
			activeFile,
			selected,
			shown: shown.map((t) => ({ path: t.path, raw: t.raw, onToday: this.plugin.isOnToday(t) })),
		});
		if (drawn === this.taskListDrawn) return;
		this.taskListDrawn = drawn;

		const focus = this.focusedTaskControl();
		el.empty();
		if (shown.length === 0) {
			const empty = this.allNotes ? 'No open tasks found.' : activeFile ? 'No open tasks in this note.' : 'Open a note to see its tasks.';
			el.createDiv({ cls: 'kiri-muted', text: empty });
			return;
		}
		shown.forEach((task, index) => {
			const row = el.createDiv({ cls: 'kiri-task' });
			row.dataset.index = String(index);
			const item = row.createDiv({ cls: 'kiri-task-main' });
			item.dataset.control = 'pick';
			item.setAttribute('role', 'button');
			item.setAttribute('tabindex', '0');
			row.toggleClass('is-selected', !!selected && selected.path === task.path && selected.raw === task.raw);
			item.createSpan({ cls: 'kiri-task-text', text: task.text });
			if (this.allNotes) item.createSpan({ cls: 'kiri-note-name', text: task.noteName });
			// Items are rebuilt when the list changes; these listeners go away with the element.
			item.addEventListener('click', () => this.plugin.selectTask(task));
			item.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter' || evt.key === ' ') {
					evt.preventDefault();
					this.plugin.selectTask(task);
				}
			});
			const onToday = this.plugin.isOnToday(task);
			const add = this.iconButton(row, onToday ? 'check' : 'plus', onToday ? 'On Today' : 'Add to Today', onToday, () => this.plugin.addToToday(task));
			add.dataset.control = 'add';
		});
		if (this.capped || this.tasks.length > shown.length) {
			el.createDiv({ cls: 'kiri-muted', text: 'Showing the first results. Type to filter.' });
		}
		if (focus) {
			const rows = el.querySelectorAll<HTMLElement>('.kiri-task');
			const row = rows[Math.min(focus.index, rows.length - 1)];
			const target = row?.querySelector<HTMLElement>(`[data-control="${focus.control}"]`);
			// A disabled "On Today" button cannot take focus: use the row's task instead.
			if (target && !(target.instanceOf(HTMLButtonElement) && target.disabled)) target.focus();
			else row?.querySelector<HTMLElement>('[data-control="pick"]')?.focus();
		}
	}

	/** The task list control that has keyboard focus now, if any. */
	private focusedTaskControl(): { index: number; control: string } | null {
		const active = activeDocument.activeElement;
		if (!active?.instanceOf(HTMLElement) || !this.taskListEl.contains(active)) return null;
		const row = active.closest<HTMLElement>('.kiri-task');
		const control = active.dataset.control;
		if (!row || !control) return null;
		return { index: Number(row.dataset.index ?? 0), control };
	}
}
