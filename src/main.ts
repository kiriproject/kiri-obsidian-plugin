import {
	type App,
	debounce,
	type Editor,
	type MarkdownFileInfo,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	requireApiVersion,
	type TAbstractFile,
	TFile,
	type WorkspaceLeaf,
} from 'obsidian';
import { type DeviceStore, KiriAccount, type SecretStore } from './account/account';
import { ApiError, formatEarnedKiris, PRICING_URL } from './account/api';
import { newBlockId } from './account/syncQueue';
import { BINAURAL_LABELS, type BinauralChoice } from './audio/binaural';
import { type CacheSize, SoundCache, type SoundSource } from './audio/soundCache';
import { PlaybackRefusedError, SoundPlayer } from './audio/soundPlayer';
import { type CycleState, EMPTY_CYCLE, type PendingBreak, planBreak, regularBreakMinutes, updatePendingBreak } from './logic/cycle';
import { BLOCK_KEY, parseSavedBlock, type SavedBlock } from './logic/savedBlock';
import { formatCountdown } from './logic/duration';
import { formatLogLine } from './logic/logLine';
import { moment } from './time';
import { addSpent, copyOf, hasUnreadableCounter, hasUnreadableSpent, incrementCounter, isOpenTask, logTaskText, parseTaskLine, plainTaskText, splitLines } from './logic/taskLine';
import {
	addManyToToday,
	addToToday,
	atPlace,
	type BlockSplit,
	closePart,
	currentChanged,
	currentToEnd,
	focusElapsedMs,
	indexOfTask,
	isUnder,
	locateTodayItem,
	mapItems,
	movedPath,
	noteNameOf,
	makeCurrent,
	MAX_TODAY,
	moveItem,
	NO_SPLIT,
	parseTodayState,
	remainingMinutes,
	removeAt,
	removeTask,
	renamePath,
	replaceTask,
	resetIfNewDay,
	samePlace,
	sameTask,
	type TodayState,
} from './logic/today';
import {
	idleState,
	isFinished,
	pause,
	remainingMs,
	resume,
	startBlock,
	type TimerState,
} from './logic/timerState';
import { DEFAULT_SETTINGS, isKiriSound, type KiriSettings, mergeSettings, SOUND_LABELS, type SoundChoice } from './settings';
import { askMarkDone } from './ui/confirmModal';
import { KiriSettingTab } from './ui/settingTab';
import { KIRI_VIEW_TYPE, KiriView } from './ui/kiriView';
import { StatsModal } from './ui/statsModal';
import { SwitchTaskModal } from './ui/switchTaskModal';
import { appendLogLine, FALLBACK_LOG_NOTE, type FallbackReason, getLogNote } from './vault/dailyNote';
import { todayKey } from './vault/stats';
import { isKanbanBoard, markTaskDone, openTasksInFile, type TaskItem, updateTaskLine } from './vault/tasks';

const FADE_IN_SECONDS = 2.5;
/**
 * A block noticed this long after its end (a closed lid, a sleeping phone,
 * Obsidian started after it ended) waits SYNC_GRACE_MS before writing to notes,
 * so a sync service can first bring today's note from another device.
 */
const LATE_FINISH_MS = 60_000;
export const SYNC_GRACE_MS = 20_000;
/**
 * "Start the next block after the break" starts at most this many blocks in a
 * row by itself. It also stops after a long break and after a break that ended
 * while the device slept, so a cycle never runs on for hours with nobody there.
 */
export const MAX_AUTO_BLOCKS = 4;
const ACTIVE_TICK_MS = 500;
const IDLE_TICK_MS = 60_000;
const BREAK_FADE_OUT_SECONDS = 3;

/** 'tick' fires twice a second for the countdown; 'change' when anything else changes. */
export type KiriEvent = 'tick' | 'change';

/** Kiri never guesses which of two identical lines to edit; these notices say so. */
const SAME_LINE_TWICE = 'or the note has the same task line more than once';
export const NOT_FOUND_TO_UPDATE = `Kiri could not find the task line to update. It may have changed, ${SAME_LINE_TWICE}. Nothing was changed.`;
export const NOT_FOUND_TO_MARK = `Kiri could not find the task line to mark done. It may have changed, ${SAME_LINE_TWICE}. Nothing was changed.`;
export const NOT_FOUND_ON_TODAY = `Kiri could not find this task in its note. It may have changed, ${SAME_LINE_TWICE}, so it stays on Today.`;

const KANBAN_NOTICE = 'This note is a Kanban board. Kiri leaves its cards alone.';

export const SWITCH_NOT_FOUND = `Kiri could not find the task you switched away from to add its time spent. It may have changed, ${SAME_LINE_TWICE}. The block goes on with the new task.`;

export default class KiriPlugin extends Plugin {
	settings: KiriSettings = DEFAULT_SETTINGS;
	timer: TimerState = idleState(DEFAULT_SETTINGS.focusMinutes);
	/**
	 * Tasks picked for today, from any notes. The first one is the current task.
	 * Saved in data.json; starts empty each day unless kept.
	 */
	today: TodayState = { day: todayKey(), items: [] };
	/** The single task picked while Today is empty. */
	picked: TaskItem | null = null;
	/** Parts of the running block given to tasks ticked done or switched away from during it. */
	private split: BlockSplit<TaskItem> = NO_SPLIT;
	/**
	 * [spent::] writes for tasks switched away from during a block, one after
	 * another, so two quick switches never edit the same line at once.
	 */
	private spentWrites: Promise<void> = Promise.resolve();
	private pendingSpentWrites = 0;
	/** Lines Kiri rewrote for those writes (old path+line text -> new item), so later edits find the line. */
	private readonly rewritten = new Map<string, TaskItem>();
	/** The "could not find the task you switched away from" notice was shown in this block. */
	private switchNoticeShown = false;
	/** Today items being marked done, so a double click does not mark twice. */
	private readonly completing = new Set<string>();
	/** Date last checked for the Today reset. */
	private dayChecked = todayKey();
	/**
	 * Line count of each note with Today tasks when Kiri last read it. A tick
	 * keeps the count (a recurring task adds one line); see locateTodayItem.
	 */
	private readonly noteLineCounts = new Map<string, number>();
	/** Shown under the countdown, e.g. after a break ends. */
	hint = '';
	/** Blocks finished in the current pomodoro cycle. */
	cycle: CycleState = EMPTY_CYCLE;
	/** Set when a block ended and its break waits for a click ("Start break when a block ends" off). */
	pendingBreak: PendingBreak | null = null;
	/** True while the running break is a long one. */
	longBreak = false;
	/** The tick interval and its period: 500 ms while a block or break runs, a minute when idle. */
	private ticker: { id: number; ms: number } | null = null;
	/** Blocks started by themselves since the last click (see MAX_AUTO_BLOCKS). */
	private autoBlocks = 0;

	/** Set when the plugin is turned off or reloaded; async work started before stops there. */
	private unloaded = false;
	/** This device's local storage (Obsidian 1.8.7 and later): the running block and the account live there. */
	private device: DeviceStore | null = null;
	/** The block state last saved to the device, to skip identical writes. */
	private savedBlockJson = '';
	/** Set once the block saved at the last close was read back. */
	private blockRestored = false;

	/** Kiri sound being downloaded, shown as a loading state. */
	soundLoading: string | null = null;
	/** The optional Kiri account. Makes no network calls until the user connects. */
	account!: KiriAccount;

	private readonly sound = new SoundPlayer();
	private soundCache!: SoundCache;
	/** Object URLs for sounds that could not be saved to disk, one per sound per session. */
	private readonly objectUrls = new Map<string, string>();
	private readonly listeners = new Set<(event: KiriEvent) => void>();
	private statusEl: HTMLElement | null = null;
	/** Resolves once Obsidian has loaded the workspace (and the vault's file list). */
	private layoutReady!: Promise<void>;
	/** Fallback notices already shown, one per reason and day. */
	private readonly fallbackNoticed = new Set<string>();
	/** Fields already warned about this session (see warnUnreadableField). */
	private readonly warnedFields = new Set<string>();
	/** Slider drags fire many changes; write settings once they settle. */
	private readonly saveSoon = debounce(() => void this.saveSettings(), 500, true);
	/** After blocks sync, read the server's kiri total once things settle (several blocks may sync in a row). */
	private readonly refreshKirisSoon = debounce(() => void this.account.refresh(), 5000, true);

	async onload(): Promise<void> {
		this.device = deviceStoreOf(this.app);
		this.account = new KiriAccount({
			secrets: secretStorageOf(this.app),
			local: this.device,
			save: () => this.saveSettings(),
			onChange: () => this.notify(),
			onDisconnected: () => {
				new Notice('Your Kiri account was disconnected. You can connect again in settings.');
				void this.afterDisconnect();
			},
			onKirisEarned: (kiris) => {
				const earned = formatEarnedKiris(kiris);
				if (earned) new Notice(`+${earned}`);
			},
			// Also after a block that earned 0: it may be a retry of one the server already counted.
			onBlocksSent: () => this.refreshKirisSoon(),
			openUrl: (url) => window.open(url),
			wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
		});
		await this.loadSettings();
		this.timer = idleState(this.settings.focusMinutes);
		const resumed = this.restoreBlock();
		this.sound.setVolume(this.settings.volume / 100);
		this.sound.setBinauralVolume(this.settings.binauralVolume / 100);
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.soundCache = new SoundCache(this.app.vault.adapter, normalizePath(`${pluginDir}/sounds`), (key) => this.account.api.sound(key));

		let layoutDone: () => void = () => undefined;
		this.layoutReady = new Promise((resolve) => (layoutDone = resolve));
		// Only with a connected account: refresh plan and sounds, and send blocks that could not be sent before.
		this.app.workspace.onLayoutReady(() => {
			layoutDone();
			void this.checkTodayNotes();
			if (!this.account.connected) return;
			void this.account.refresh();
			void this.account.flush();
		});

		this.registerView(KIRI_VIEW_TYPE, (leaf: WorkspaceLeaf) => new KiriView(leaf, this));

		this.addRibbonIcon('timer', 'Open Kiri', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-view',
			name: 'Open Kiri',
			callback: () => {
				void this.activateView();
			},
		});
		this.addCommand({
			id: 'start-focus',
			name: 'Start focus block',
			checkCallback: (checking) => {
				if (this.timer.phase === 'focus') return false;
				if (!checking) this.startFocus();
				return true;
			},
		});
		this.addCommand({
			id: 'start-pause',
			name: 'Start or pause',
			callback: () => {
				if (this.timer.phase === 'idle') this.startFocus();
				else this.togglePause();
			},
		});
		this.addCommand({
			id: 'pause-resume',
			name: 'Pause or resume',
			checkCallback: (checking) => {
				if (this.timer.phase === 'idle') return false;
				if (!checking) this.togglePause();
				return true;
			},
		});
		this.addCommand({
			id: 'stop',
			name: 'Stop timer',
			checkCallback: (checking) => {
				if (this.timer.phase === 'idle') return false;
				if (!checking) this.stop();
				return true;
			},
		});
		this.addCommand({
			id: 'skip-break',
			name: 'Skip break',
			checkCallback: (checking) => {
				if (this.timer.phase !== 'break' && !this.pendingBreak) return false;
				if (!checking) this.skipBreak();
				return true;
			},
		});
		this.addCommand({
			id: 'focus-on-task',
			name: 'Focus on this task',
			editorCheckCallback: (checking, editor, info) => {
				const task = taskAtCursor(this.app, editor, info);
				if (!task) return false;
				if (!checking) this.focusOnTask(task);
				return true;
			},
		});
		this.addCommand({
			id: 'switch-task',
			name: 'Switch task…',
			callback: () => {
				void this.openSwitchTask();
			},
		});
		this.addCommand({
			id: 'next-task',
			name: 'Next task',
			callback: () => {
				if (this.nextTask()) this.noticeCurrent();
			},
		});
		this.addCommand({
			id: 'add-note-tasks-to-today',
			name: 'Add open tasks from this note to Today',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void this.addNoteTasksToToday(file);
				return true;
			},
		});
		this.addCommand({
			id: 'open-stats',
			name: 'Show focus stats',
			callback: () => this.openStats(),
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, info) => {
				const task = taskAtCursor(this.app, editor, info);
				if (!task) return;
				menu.addItem((item) =>
					item
						.setTitle('Focus on this task')
						.setIcon('timer')
						.onClick(() => this.focusOnTask(task)),
				);
				menu.addItem((item) =>
					item
						.setTitle('Add to Today')
						.setIcon('list-plus')
						.setDisabled(this.isOnToday(task))
						.onClick(() => this.addToToday(task)),
				);
			}),
		);

		this.registerTodayEvents();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('kiri-status', 'mod-clickable');
		this.registerDomEvent(this.statusEl, 'click', () => {
			void this.activateView();
		});

		this.addSettingTab(new KiriSettingTab(this.app, this));

		this.updateStatusBar();
		this.scheduleTicks();
		if (resumed) this.resumeRestored();
	}

	onunload(): void {
		// Keep the running block for the next start (a reload, an update, closing Obsidian).
		this.saveBlock();
		// First: async work still running (a sound download, a block being recorded) checks this.
		this.unloaded = true;
		this.account.cancelConnect();
		this.refreshKirisSoon.cancel();
		this.saveSoon.run();
		this.sound.dispose();
		this.releaseObjectUrls();
		this.listeners.clear();
	}

	/** Follow Today's tasks when their notes change, move or go away. */
	registerTodayEvents(): void {
		// Notice tasks on Today that were ticked or changed in the note itself.
		this.registerEvent(this.app.metadataCache.on('changed', (file, data) => this.onNoteChanged(file, data)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRenamed(file, oldPath)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDeleted(file)));
	}

	/**
	 * data.json changed outside this Obsidian (for example synced from another
	 * device): take the Today list from it, so the next save does not overwrite it.
	 */
	async onExternalSettingsChange(): Promise<void> {
		const data: unknown = await this.loadData();
		const saved = data && typeof data === 'object' ? (data as { today?: unknown }).today : undefined;
		this.account.takeShared(data);
		if (saved === undefined) return;
		const day = todayKey();
		let next = parseTodayState(saved, day);
		if (this.timer.phase !== 'focus') next = resetIfNewDay(next, day, this.settings.keepToday);
		if (JSON.stringify(next) === JSON.stringify(this.today)) return;
		this.today = next;
		if (next.items.length > 0) this.picked = null;
		this.notify();
		void this.checkTodayNotes();
	}

	async loadSettings(): Promise<void> {
		const data: unknown = await this.loadData();
		this.settings = mergeSettings(data);
		const saved = data && typeof data === 'object' ? (data as { today?: unknown }).today : undefined;
		const day = todayKey();
		this.today = resetIfNewDay(parseTodayState(saved, day), day, this.settings.keepToday);
		this.dayChecked = day;
		// True when the token moved into secret storage or old data was upgraded.
		if (this.account.load(data)) await this.saveSettings();
	}

	/**
	 * Settings and the Today list live in the plugin's data.json. The account
	 * record and the queue of unsent blocks live in this device's local storage
	 * (Obsidian 1.8.7 and later; before that in data.json), and the token in
	 * Obsidian's secret storage (1.11.4 and later; before that next to the account record).
	 */
	async saveSettings(): Promise<void> {
		this.account.saveDevice();
		await this.saveData({ ...this.settings, ...this.account.toData(), today: this.today });
		this.notify();
	}

	/** Views subscribe to state changes. Returns an unsubscribe function. */
	subscribe(listener: (event: KiriEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	remaining(): number {
		return remainingMs(this.timer, Date.now());
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(KIRI_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: KIRI_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	// Timer actions

	setFocusMinutes(minutes: number): void {
		this.settings.focusMinutes = minutes;
		if (this.timer.phase === 'idle') this.timer = idleState(minutes);
		void this.saveSettings();
	}

	/**
	 * Set the regular break: minutes (1–60), or null for Auto (by block length).
	 * A running break keeps its length; the new one applies from the next break.
	 * A regular break waiting for a click takes the new length; a long one does not.
	 */
	setBreakMinutes(minutes: number | null): void {
		this.settings.breakMinutes = minutes;
		this.pendingBreak = updatePendingBreak(this.pendingBreak, this.settings, this.settings.focusMinutes);
		void this.saveSettings();
	}

	/**
	 * What Auto gives for the next regular break: for the block a waiting break
	 * follows, otherwise for the block length now set.
	 */
	autoBreakMinutes(): number {
		const pending = this.pendingBreak;
		const block = pending && !pending.isLong ? (pending.blockMinutes ?? this.settings.focusMinutes) : this.settings.focusMinutes;
		return regularBreakMinutes(block, { breaks: this.settings.breaks, breakMinutes: null });
	}

	/**
	 * The task the timer works on: the first task on Today, or the single
	 * picked task while Today is empty.
	 */
	get task(): TaskItem | null {
		return this.today.items[0] ?? this.picked;
	}

	/**
	 * Make a task the current one. While Today has tasks, the task moves (or is
	 * added) to the top of Today; otherwise it becomes the single picked task.
	 * Returns false when Today is full and the task could not be added.
	 */
	selectTask(task: TaskItem | null): boolean {
		return this.switching(() => {
			if (this.today.items.length === 0 || !task) {
				this.picked = task;
				this.notify();
				return true;
			}
			const r = makeCurrent(this.today.items, task);
			if (r.result === 'full') {
				new Notice(`Today is full (${MAX_TODAY} tasks). Remove one first.`);
				return false;
			}
			this.setToday(r.items);
			return true;
		});
	}

	/**
	 * "Next task": the current task goes to the end of Today (it stays open and
	 * on the list) and the second one becomes current. Returns false, with a
	 * notice, when Today has no other task.
	 */
	nextTask(): boolean {
		if (this.today.items.length < 2) {
			new Notice('No other task on Today.');
			return false;
		}
		this.switching(() => this.setToday(currentToEnd(this.today.items)));
		return true;
	}

	// Today

	isOnToday(task: { path: string; raw: string }): boolean {
		return indexOfTask(this.today.items, task) !== -1;
	}

	/** Add a task to the end of Today. */
	addToToday(task: TaskItem): void {
		const items = this.withPickedFirst();
		const r = addToToday(items, task);
		if (r.result === 'full') new Notice(`Today is full (${MAX_TODAY} tasks). Remove one first.`);
		this.setToday(r.items);
	}

	/** Add every open task of a note to Today, in note order. */
	async addNoteTasksToToday(file: TFile): Promise<void> {
		if (isKanbanBoard(this.app, file)) {
			new Notice(KANBAN_NOTICE);
			return;
		}
		const tasks = await openTasksInFile(this.app, file);
		if (tasks.length === 0) {
			new Notice('This note has no open tasks.');
			return;
		}
		const r = addManyToToday(this.withPickedFirst(), tasks);
		this.setToday(r.items);
		if (r.full) new Notice(`Added ${r.added} of ${tasks.length}. Today is full (${MAX_TODAY} tasks).`);
		else if (r.added === 0) new Notice('These tasks are already on Today.');
		else new Notice(r.added === 1 ? 'Added 1 task to Today.' : `Added ${r.added} tasks to Today.`);
	}

	moveTodayItem(from: number, to: number): void {
		this.switching(() => this.setToday(moveItem(this.today.items, from, to)));
	}

	/** Take a task off Today without changing its note. The current task gets its part of a running block first. */
	removeTodayItem(index: number): void {
		this.switching(() => this.setToday(removeAt(this.today.items, index)));
	}

	/**
	 * Run a change made by the user to Today or the single pick. When it changes
	 * the current task during a focus block, the outgoing task gets its part of
	 * the block so far (added to its [spent::] when that setting is on, never
	 * marked done) and the rest goes on to the new current task, as when a task
	 * is ticked during a block.
	 */
	private switching<T>(change: () => T): T {
		const before = this.task;
		const result = change();
		if (this.timer.phase === 'focus' && before && currentChanged(before, this.task)) this.giveSwitchedPart(before);
		return result;
	}

	/** Close the outgoing task's part of the running block and write its minutes (see switching). */
	private giveSwitchedPart(task: TaskItem): void {
		const r = closePart(this.split, focusElapsedMs(this.timer.minutes, this.remaining()), task, false);
		this.split = r.split;
		this.notify();
		// A part under half a minute (a quick double switch) writes nothing.
		if (r.minutes <= 0 || !this.settings.writeSpent) return;
		this.queueSpentWrite(task, r.minutes);
	}

	/**
	 * Add `minutes` to a switched-away task's [spent::], after any such write
	 * still running. A line that cannot be found is left alone with one notice
	 * per block; the block and its split go on either way.
	 */
	private queueSpentWrite(task: TaskItem, minutes: number): void {
		this.pendingSpentWrites++;
		this.spentWrites = this.spentWrites
			.then(async () => {
				if (this.unloaded) return;
				const ref = this.latestLine(task);
				let unreadable = false;
				const updated = await updateTaskLine(this.app, ref, (line) => {
					const next = this.withSpent(line, minutes);
					if (next === null) unreadable = true;
					return next;
				});
				if (updated) {
					const next = atPlace({ ...ref, raw: updated.raw, text: parseTaskLine(updated.raw)?.text ?? ref.text }, updated.line, {
						copy: updated.copy ?? 0,
						copies: updated.copies ?? 1,
					});
					this.rewritten.set(lineKey(ref), next);
					this.followTask(ref, next);
				} else if (!unreadable) {
					this.noticeSwitchNotFound();
				}
			})
			.catch((err) => {
				console.error('Kiri: could not add the time spent to a task switched away from', err);
				this.noticeSwitchNotFound();
			})
			.finally(() => {
				this.pendingSpentWrites--;
			});
	}

	private noticeSwitchNotFound(): void {
		if (this.switchNoticeShown) return;
		this.switchNoticeShown = true;
		new Notice(SWITCH_NOT_FOUND);
	}

	/** The task's line as Kiri last rewrote it for a switch, so a later edit finds it. */
	private latestLine(task: TaskItem): TaskItem {
		let ref = task;
		for (let i = 0; i < 100; i++) {
			const next = this.rewritten.get(lineKey(ref));
			if (!next) break;
			ref = next;
		}
		return ref;
	}


	/**
	 * Tick a Today task: mark it done in its note and take it off the list, so
	 * the next task becomes current. When it is the current task of a running
	 * block, the block goes on: the time so far is added to this task's
	 * [spent::] (if that setting is on) and the rest of the block goes to the next task.
	 */
	async completeTodayItem(clicked: TaskItem): Promise<boolean> {
		// A switch may still be adding time to this very line.
		if (this.pendingSpentWrites > 0) await this.spentWrites;
		const task = this.latestLine(clicked);
		const key = lineKey(task);
		if (this.completing.has(key)) return false;
		const index = indexOfTask(this.today.items, task);
		if (index === -1) return false;
		this.completing.add(key);
		try {
			const part = index === 0 ? this.takeBlockPart(task, true) : null;
			const minutes = part?.minutes ?? 0;
			const done = await markTaskDone(this.app, task, (line) => this.withSpent(line, minutes));
			if (!done) {
				if (part) part.undo();
				new Notice(NOT_FOUND_ON_TODAY);
				this.notify();
				return false;
			}
			this.setToday(removeTask(this.today.items, task));
			return true;
		} finally {
			this.completing.delete(key);
		}
	}

	/**
	 * Today's items, with the single picked task put first when Today is still
	 * empty, so the task being worked on stays current when Today starts.
	 */
	private withPickedFirst(): TaskItem[] {
		const items = this.today.items;
		if (items.length > 0 || !this.picked) return [...items];
		return addToToday(items, this.picked).items;
	}

	/** Replace the Today list, save it and redraw. The single pick is merged into Today. */
	private setToday(items: TaskItem[]): void {
		this.today = { day: this.today.day, items };
		if (items.length > 0) this.picked = null;
		for (const path of new Set(items.map((i) => i.path))) {
			if (!this.noteLineCounts.has(path)) void this.readTodayNote(path, false);
		}
		void this.saveSettings();
	}

	/**
	 * Give the time the current task got in the running focus block to that
	 * task, so the rest of the block goes to the next one. Returns null outside
	 * a focus block. `undo` gives the time back if the task could not be marked done.
	 */
	private takeBlockPart(task: TaskItem, done: boolean): { minutes: number; undo: () => void } | null {
		if (this.timer.phase !== 'focus') return null;
		const before = this.split;
		const part = closePart(before, focusElapsedMs(this.timer.minutes, this.remaining()), task, done);
		const startedAt = this.timer.startedAt;
		this.split = part.split;
		return {
			minutes: part.minutes,
			undo: () => {
				if (this.timer.phase === 'focus' && this.timer.startedAt === startedAt) this.split = before;
			},
		};
	}

	/** The line with `minutes` added to its [spent::] field, when that setting is on; null to leave it. */
	private withSpent(line: string, minutes: number): string | null {
		if (!this.settings.writeSpent || minutes <= 0) return null;
		if (hasUnreadableSpent(line)) {
			this.warnUnreadableField('spent');
			return null;
		}
		return addSpent(line, minutes);
	}

	/**
	 * A note changed: follow its Today tasks. A task ticked done in the note
	 * leaves Today (getting its part of a running block, like a tick in the
	 * panel); a task whose fields changed is followed to its new line; a task
	 * that cannot be found any more is marked stale (and recovers if it comes back).
	 */
	private onNoteChanged(file: TFile, data: string): void {
		const onToday = this.today.items.some((i) => i.path === file.path);
		const isPicked = this.picked?.path === file.path;
		// Most changes are to notes Kiri does not follow: do not even split those.
		if (!onToday && !isPicked) {
			this.noteLineCounts.delete(file.path);
			return;
		}
		const { lines } = splitLines(data);
		if (isPicked) this.followPicked(lines);
		if (onToday) this.followTodayNote(file.path, lines, true);
	}

	/**
	 * Keep the single picked task's line and copy up to date on every change of
	 * its note, like Today's tasks, so an edit after the block finds the right
	 * one of two identical lines. A task that cannot be found is left as it
	 * was; editing it then fails safely with a notice.
	 */
	private followPicked(lines: readonly string[]): void {
		const picked = this.picked;
		if (!picked) return;
		const where = locateTodayItem(picked, lines);
		let next: TaskItem | null = null;
		if (where.kind === 'same') {
			if (!samePlace(picked, where.line, where.copy)) next = atPlace(picked, where.line, where.copy);
		} else if (where.kind === 'changed') {
			next = atPlace({ ...picked, raw: where.raw, text: where.text }, where.line, where.copy);
		}
		if (!next) return;
		this.picked = next;
		this.notify();
	}

	/**
	 * Find each Today task of one note in its current lines. `fromEdit` is false
	 * when Kiri only reads the note (at start), so nothing counts as a block part.
	 */
	private followTodayNote(path: string, lines: readonly string[], fromEdit: boolean): void {
		const previousCount = this.noteLineCounts.get(path);
		const items = this.today.items;
		if (!items.some((i) => i.path === path)) {
			this.noteLineCounts.delete(path);
			return;
		}
		this.noteLineCounts.set(path, lines.length);
		let next = [...items];
		let changed = false;
		items.forEach((item, index) => {
			if (item.path !== path || this.completing.has(lineKey(item))) return;
			const where = locateTodayItem(item, lines, previousCount);
			if (where.kind === 'same') {
				if (samePlace(item, where.line, where.copy) && !item.stale) return;
				next = replaceTask(next, item, atPlace({ ...item, stale: false }, where.line, where.copy));
				changed = true;
			} else if (where.kind === 'changed') {
				next = replaceTask(next, item, atPlace({ ...item, raw: where.raw, text: where.text, stale: false }, where.line, where.copy));
				changed = true;
			} else if (where.kind === 'missing') {
				if (item.stale) return;
				next = replaceTask(next, item, { ...item, stale: true });
				changed = true;
			} else {
				next = removeTask(next, item);
				changed = true;
				const part = fromEdit && index === 0 ? this.takeBlockPart(item, true) : null;
				if (part && part.minutes > 0 && this.settings.writeSpent) {
					// Only this item's own completed line (see locateTodayItem), never an older copy.
					const closed = atPlace({ ...item, raw: where.raw }, where.line, where.copy);
					void updateTaskLine(this.app, closed, (line) => this.withSpent(line, part.minutes)).catch((err) => {
						console.error('Kiri: could not add the time spent to a finished task', err);
					});
				}
			}
		});
		if (changed) this.setToday(next);
	}

	/** Read a note with Today tasks: remember its line count, and (when `follow`) find its tasks. */
	private async readTodayNote(path: string, follow: boolean): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			if (follow) this.markStale((p) => p === path);
			return;
		}
		const { lines } = splitLines(await this.app.vault.cachedRead(file));
		if (follow) this.followTodayNote(path, lines, false);
		else if (this.today.items.some((i) => i.path === path)) this.noteLineCounts.set(path, lines.length);
	}

	/**
	 * At start (and after data.json changed outside): find Today's tasks in their
	 * notes, which may have changed while Obsidian was closed.
	 */
	async checkTodayNotes(): Promise<void> {
		for (const path of new Set(this.today.items.map((i) => i.path))) {
			try {
				await this.readTodayNote(path, true);
			} catch (err) {
				console.error('Kiri: could not read a note with Today tasks', err);
			}
		}
	}

	/** A note or folder was renamed or moved: its Today tasks (and the picked task) follow it. */
	private onFileRenamed(file: TAbstractFile, oldPath: string): void {
		const isFolder = !(file instanceof TFile);
		const move = (path: string): string | null => movedPath(path, oldPath, file.path, isFolder);
		for (const [path, count] of [...this.noteLineCounts]) {
			const moved = move(path);
			if (moved === null) continue;
			this.noteLineCounts.delete(path);
			this.noteLineCounts.set(moved, count);
		}
		const follow = <T extends TaskItem>(task: T): T => {
			const moved = move(task.path);
			return moved === null ? task : { ...task, path: moved, noteName: noteNameOf(moved) };
		};
		if (this.picked) this.picked = follow(this.picked);
		if (this.split.finished.length > 0) this.split = { ...this.split, finished: this.split.finished.map(follow) };
		for (const [key, item] of [...this.rewritten]) this.rewritten.set(key, follow(item));
		const r = renamePath(this.today.items, oldPath, file.path, isFolder);
		if (r.changed) this.setToday(r.items);
		else this.notify();
	}

	/** A note (or folder) was deleted: its Today tasks stay, marked as not found, until removed. */
	private onFileDeleted(file: TAbstractFile): void {
		const isFolder = !(file instanceof TFile);
		for (const path of [...this.noteLineCounts.keys()]) {
			if (isUnder(path, file.path, isFolder)) this.noteLineCounts.delete(path);
		}
		this.markStale((path) => isUnder(path, file.path, isFolder));
	}

	private markStale(where: (path: string) => boolean): void {
		const r = mapItems(this.today.items, (i) => (where(i.path) && !i.stale ? { ...i, stale: true } : null));
		if (r.changed) this.setToday(r.items);
	}

	/**
	 * At local midnight Today starts empty, unless it is kept across days.
	 * Not during a focus block: the block keeps its task, and the list is
	 * cleared on the first tick after the block ends.
	 */
	private checkNewDay(): void {
		const day = todayKey();
		if (day === this.dayChecked) return;
		if (this.timer.phase === 'focus') return;
		this.dayChecked = day;
		const next = resetIfNewDay(this.today, day, this.settings.keepToday);
		if (next === this.today) return;
		this.today = next;
		void this.saveSettings();
	}

	/**
	 * "Switch task…": pick the current task from Today with a fuzzy search.
	 * While Today is empty, the open tasks of the active note are offered
	 * instead (the choice becomes the single picked task).
	 */
	async openSwitchTask(): Promise<void> {
		let tasks: TaskItem[] = this.today.items;
		if (tasks.length === 0) {
			const file = this.app.workspace.getActiveFile();
			tasks = file && file.extension === 'md' ? await openTasksInFile(this.app, file) : [];
			if (tasks.length === 0) {
				new Notice('Today is empty, and the open note has no open tasks. Add tasks to Today in the Kiri panel.');
				return;
			}
		}
		new SwitchTaskModal(this.app, tasks, this.task, (task) => {
			if (this.selectTask(task)) this.noticeCurrent();
		}).open();
	}

	/** After a switch from a command (the panel may be closed): say which task is current now. */
	private noticeCurrent(): void {
		const task = this.task;
		if (task) new Notice(`Now focusing on: ${plainTaskText(task.text) || task.text}`);
	}

	/** Pick a task from the editor and start a block on it (or switch the running block to it). */
	focusOnTask(task: TaskItem): void {
		if (!this.selectTask(task)) return;
		void this.activateView();
		if (this.timer.phase === 'focus') {
			new Notice(`Now focusing on: ${plainTaskText(task.text) || task.text}`);
			return;
		}
		this.startFocus();
	}

	openStats(): void {
		new StatsModal(this.app, this.kirisTotal()).open();
	}

	/** Kiris on the connected account, or null when not connected or the server did not say. */
	kirisTotal(): number | null {
		return this.account.info?.kirisTotal ?? null;
	}

	/** Start a focus block. `auto` is for a block started by itself after a break; any other start counts as the user being there. */
	startFocus(auto = false): void {
		this.autoBlocks = auto ? this.autoBlocks + 1 : 0;
		this.split = NO_SPLIT;
		this.switchNoticeShown = false;
		if (this.pendingSpentWrites === 0) this.rewritten.clear();
		this.hint = '';
		this.pendingBreak = null;
		this.longBreak = false;
		this.timer = startBlock('focus', this.settings.focusMinutes, Date.now());
		this.playChosenSound();
		this.notify();
	}

	togglePause(): void {
		this.autoBlocks = 0;
		const now = Date.now();
		if (this.timer.running) {
			this.timer = pause(this.timer, now);
			this.stopSounds(1);
		} else {
			this.timer = resume(this.timer, now);
			if (this.timer.phase === 'focus') this.playChosenSound();
		}
		this.notify();
	}

	stop(): void {
		this.autoBlocks = 0;
		this.split = NO_SPLIT;
		this.timer = idleState(this.settings.focusMinutes);
		this.hint = '';
		this.pendingBreak = null;
		this.longBreak = false;
		this.stopSounds(1);
		this.notify();
	}

	/** Start the break that is waiting for a click. */
	startBreak(): void {
		const pending = this.pendingBreak;
		if (!pending) return;
		this.autoBlocks = 0;
		this.pendingBreak = null;
		this.hint = '';
		this.longBreak = pending.isLong;
		this.timer = startBlock('break', pending.minutes, Date.now());
		this.notify();
	}

	/** End the break now (or drop the waiting one). Kiri then waits for the next start. */
	skipBreak(): void {
		if (this.timer.phase !== 'break' && !this.pendingBreak) return;
		this.stop();
		this.hint = 'Break skipped. Start the next block when ready.';
		this.notify();
	}

	/** Sounds to offer: the local noises, plus Kiri sounds when an account is connected. */
	soundOptions(): { value: SoundChoice; label: string; locked: boolean }[] {
		const local = (Object.keys(SOUND_LABELS) as (keyof typeof SOUND_LABELS)[]).map((value): { value: SoundChoice; label: string; locked: boolean } => ({
			value,
			label: SOUND_LABELS[value],
			locked: false,
		}));
		const info = this.account.info;
		if (!info || info.sounds.length === 0) return local;
		const [off, ...noises] = local;
		const remote = info.sounds.map((s) => ({
			value: `kiri:${s.key}` as SoundChoice,
			label: s.available ? s.label : `${s.label} (locked)`,
			locked: !s.available,
		}));
		const madeHere = noises.map((n) => ({ ...n, label: `${n.label} (made on device)` }));
		return [...(off ? [off] : []), ...remote, ...madeHere];
	}

	/** True when some Kiri sounds need a paid account. */
	hasLockedSounds(): boolean {
		return this.account.info?.sounds.some((s) => !s.available) ?? false;
	}

	/** Change the sound. Returns false (and changes nothing) for a locked Kiri sound. */
	setSound(sound: SoundChoice): boolean {
		if (isKiriSound(sound)) {
			const key = sound.slice(5);
			const entry = this.account.info?.sounds.find((s) => s.key === key);
			if (!entry || !entry.available) {
				new Notice(`${entry?.label ?? 'This sound'} needs a paid Kiri account. See ${PRICING_URL}`);
				this.notify();
				return false;
			}
		}
		this.settings.sound = sound;
		if (this.timer.phase === 'focus' && this.timer.running) this.playChosenSound(1.5);
		void this.saveSettings();
		return true;
	}

	/** True when the connected account may use at least one binaural beat. */
	binauralAllowed(): boolean {
		const access = this.account.info?.binaural ?? 'none';
		return access !== 'none';
	}

	/** True when the account may use this beat: all of them with 'full', only Alpha with 'alpha'. */
	beatAllowed(choice: BinauralChoice): boolean {
		const access = this.account.info?.binaural ?? 'none';
		if (choice === 'off' || access === 'none') return false;
		return access === 'full' || choice === 'alpha';
	}

	/** The beats to offer in settings, with "Off" first. */
	binauralOptions(): Partial<Record<BinauralChoice, string>> {
		if (this.account.info?.binaural === 'alpha') return { off: BINAURAL_LABELS.off, alpha: BINAURAL_LABELS.alpha };
		return BINAURAL_LABELS;
	}

	setBinaural(choice: BinauralChoice): void {
		this.settings.binaural = choice;
		if (this.timer.phase === 'focus' && this.timer.running) this.playBinaural();
		void this.saveSettings();
	}

	setBinauralVolume(volume: number): void {
		this.settings.binauralVolume = volume;
		this.sound.setBinauralVolume(volume / 100);
		this.saveSoon();
	}

	/** Disconnect the Kiri account: revoke the token, forget it, and go back to the local sounds. */
	async disconnectAccount(): Promise<void> {
		await this.account.disconnect();
		await this.afterDisconnect();
	}

	/** Device name sent when connecting, as the contract asks: "Obsidian on <device>". */
	deviceName(): string {
		if (Platform.isPhone) return 'Obsidian on this phone';
		if (Platform.isTablet) return 'Obsidian on this tablet';
		return 'Obsidian on this computer';
	}

	private async afterDisconnect(): Promise<void> {
		if (isKiriSound(this.settings.sound)) {
			this.settings.sound = 'off';
			this.sound.stop(1);
		}
		this.sound.stopBinaural(1);
		this.sound.forgetRecordings();
		this.releaseObjectUrls();
		this.soundLoading = null;
		try {
			await this.soundCache.clear();
		} catch {
			// The files can stay; they are only used with a connected account.
		}
		await this.saveSettings();
	}

	previewChime(): void {
		this.sound.chime(this.settings.chimeStyle);
	}

	setVolume(volume: number): void {
		this.settings.volume = volume;
		this.sound.setVolume(volume / 100);
		this.saveSoon();
	}

	private stopSounds(fadeSeconds: number): void {
		this.sound.stop(fadeSeconds);
		this.sound.stopBinaural(fadeSeconds);
		if (this.soundLoading) {
			this.soundLoading = null;
			this.notify();
		}
	}

	private playChosenSound(fadeSeconds = FADE_IN_SECONDS): void {
		this.playBinaural();
		const sound = this.settings.sound;
		if (sound === 'off') {
			this.sound.stop(1);
			return;
		}
		if (!isKiriSound(sound)) {
			this.sound.play(sound, fadeSeconds);
			return;
		}
		const key = sound.slice(5);
		if (!this.account.info?.sounds.some((s) => s.key === key && s.available)) {
			// Not connected any more, or no longer in the plan: stay quiet.
			this.sound.stop(1);
			return;
		}
		if (this.sound.playingId === sound) return;
		void this.playKiriSound(sound, key, fadeSeconds);
	}

	private async playKiriSound(sound: SoundChoice, key: string, fadeSeconds: number): Promise<void> {
		this.soundLoading = key;
		this.notify();
		try {
			const source = await this.soundCache.ensure(key);
			// The plugin may have been turned off, the block ended, or another sound picked while it downloaded.
			if (this.unloaded) return;
			if (this.settings.sound !== sound || this.timer.phase !== 'focus' || !this.timer.running) return;
			await this.sound.playRecording(sound, this.sourceUrl(key, source), fadeSeconds);
		} catch (err) {
			if (this.unloaded) return;
			if (err instanceof PlaybackRefusedError) {
				new Notice('Kiri could not start the sound. Pause and resume the block to try again.');
			} else if (err instanceof ApiError && err.status === 403) {
				new Notice(`This sound needs a paid Kiri account. See ${PRICING_URL}`);
				void this.account.refresh();
			} else if (err instanceof ApiError && err.status === 401) {
				// The account was disconnected; a notice is already shown.
			} else {
				new Notice('Kiri could not load this sound. Check your connection and try again.');
			}
		} finally {
			if (this.soundLoading === key && !this.unloaded) {
				this.soundLoading = null;
				this.notify();
			}
		}
	}

	/**
	 * What the audio element plays: the cached file's resource path (streamed
	 * from disk, never read into memory), or an object URL made once per sound
	 * this session when the file could not be saved.
	 */
	private sourceUrl(key: string, source: SoundSource): string {
		if (this.unloaded) return '';
		if (source.kind === 'file') return this.app.vault.adapter.getResourcePath(source.path);
		let url = this.objectUrls.get(key);
		if (!url) {
			url = URL.createObjectURL(new Blob([source.data], { type: 'audio/mpeg' }));
			this.objectUrls.set(key, url);
		}
		return url;
	}

	private releaseObjectUrls(): void {
		for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
		this.objectUrls.clear();
	}

	/** The folder downloaded Kiri sounds go to, relative to the vault. */
	soundsFolder(): string {
		return this.soundCache.dir;
	}

	/** Number and size of the downloaded Kiri sounds. */
	downloadedSoundsSize(): Promise<CacheSize> {
		return this.soundCache.size().catch(() => ({ files: 0, bytes: 0 }));
	}

	/** Delete the downloaded Kiri sounds. A sound picked again is downloaded again when played. */
	async clearDownloadedSounds(): Promise<void> {
		const playing = this.sound.playingId;
		if (playing && isKiriSound(playing)) this.sound.stop(0.3);
		this.sound.forgetRecordings();
		this.releaseObjectUrls();
		await this.soundCache.clear();
		this.notify();
	}

	private playBinaural(): void {
		const choice = this.settings.binaural;
		if (choice === 'off' || !this.beatAllowed(choice)) this.sound.stopBinaural(1);
		else this.sound.startBinaural(choice, FADE_IN_SECONDS);
	}

	private tick(): void {
		const now = Date.now();
		this.checkNewDay();
		if (isFinished(this.timer, now)) {
			const finished = this.timer;
			if (finished.phase === 'focus') this.onFocusDone(finished, now);
			else this.onBreakDone(now - finished.endAt > LATE_FINISH_MS);
		}
		this.updateStatusBar();
		for (const listener of this.listeners) listener('tick');
	}

	private onFocusDone(finished: TimerState, now: number): void {
		if (this.settings.chime) this.sound.chime(this.settings.chimeStyle);
		// The task current at the end gets what is left of the block after the parts
		// given to tasks ticked done during it.
		const task = this.task;
		const split = this.split;
		this.split = NO_SPLIT;
		const minutesLeft = remainingMinutes(finished.minutes, split.given);
		// The log line and the block sent to Kiri name the task current at the end,
		// or, if none is left, the first task finished during the block.
		const named = task ?? split.finished[0] ?? null;
		const plan = planBreak(this.cycle, finished.minutes, this.settings, now);
		this.cycle = plan.cycle;

		if (this.settings.breaksEnabled && this.settings.autoStartBreak) {
			this.timer = startBlock('break', plan.minutes, now);
			this.longBreak = plan.isLong;
			this.stopSounds(BREAK_FADE_OUT_SECONDS);
			this.hint = '';
		} else if (this.settings.breaksEnabled) {
			this.timer = idleState(this.settings.focusMinutes);
			this.pendingBreak = { minutes: plan.minutes, isLong: plan.isLong, blockMinutes: finished.minutes };
			this.stopSounds(BREAK_FADE_OUT_SECONDS);
			this.hint = plan.isLong ? 'Block done. Time for a long break.' : 'Block done. Start your break when ready.';
		} else {
			this.timer = idleState(this.settings.focusMinutes);
			this.stopSounds(BREAK_FADE_OUT_SECONDS);
			this.hint = 'Block done.';
		}
		new Notice('Focus block done.');
		this.notify();

		void this.recordBlock(finished, now, named, task, minutesLeft);
	}

	/** `late`: the break ended a while before Kiri noticed (the device slept). */
	private onBreakDone(late = false): void {
		if (this.settings.chime) this.sound.chime(this.settings.chimeStyle);
		const wasLong = this.longBreak;
		this.longBreak = false;
		const autoAllowed = !late && !wasLong && this.autoBlocks < MAX_AUTO_BLOCKS;
		if (this.settings.autoStartNext && autoAllowed) {
			this.startFocus(true);
			return;
		}
		this.timer = idleState(this.settings.focusMinutes);
		this.hint =
			this.settings.autoStartNext && this.autoBlocks > 0
				? 'Break over. Kiri waits for you before starting more blocks by itself.'
				: 'Break over. Start the next block when ready.';
		this.autoBlocks = 0;
		new Notice('Break over.');
		this.notify();
	}

	/**
	 * Log line, task counter and the optional "Mark task done?" question.
	 * `named` is the task the log line and Kiri history show; `task` is the one
	 * current at the end, which gets `minutes` (the block minus parts given to
	 * tasks finished during it).
	 */
	private async recordBlock(finished: TimerState, endedAt: number, named: TaskItem | null, task: TaskItem | null, minutes: number): Promise<void> {
		this.syncBlock(finished, named);
		try {
			await this.writeLog(finished, endedAt, named);
			await this.updateTask(task, minutes);
		} catch (err) {
			console.error('Kiri: could not record the focus block', err);
			new Notice('Kiri could not update your notes. See the developer console for details.');
		}
		this.notify();
	}

	/** Send the block to the connected Kiri account in the background. Never blocks the log or the UI. */
	private syncBlock(finished: TimerState, task: TaskItem | null): void {
		if (!this.account.connected || !this.settings.syncEnabled) return;
		const sound = this.settings.sound;
		const soundPlayed = isKiriSound(sound) ? this.account.info?.sounds.some((s) => s.key === sound.slice(5) && s.available) : true;
		void this.account.sendBlock({
			id: newBlockId(),
			startedAt: finished.startedAt,
			durationSeconds: finished.minutes * 60,
			sound: soundPlayed ? sound : 'off',
			binaural: this.beatAllowed(this.settings.binaural) ? this.settings.binaural : 'off',
			intent: task ? logTaskText(task.text) : '',
		});
	}

	private async writeLog(finished: TimerState, endedAt: number, task: TaskItem | null): Promise<void> {
		if (!this.settings.logToDailyNote) return;
		// Never look for today's note before Obsidian knows the vault's files.
		await this.layoutReady;
		if (endedAt - finished.endAt > LATE_FINISH_MS) {
			// Just woke up or started: give a sync service time to bring today's note first.
			await new Promise<void>((resolve) => window.setTimeout(resolve, SYNC_GRACE_MS));
		}
		const target = await getLogNote(this.app, { createDailyNote: this.settings.createDailyNote });
		if (target.reason) this.noticeFallback(target.reason, target.template);
		const logNote = target.file;
		const taskFile = task ? this.app.vault.getFileByPath(task.path) : null;
		const link = taskFile ? this.app.fileManager.generateMarkdownLink(taskFile, logNote.path) : undefined;
		// The block ended at endAt (start + length + any pause), not when the tick noticed it:
		// after a closed lid or a sleeping phone that can be hours later.
		const end = Math.min(endedAt, finished.endAt);
		const pausedMs = end - finished.startedAt - finished.minutes * 60_000;
		const line = formatLogLine({
			// The fallback note has no date of its own, so its lines carry one (for stats).
			date: target.dated ? moment(end).format('YYYY-MM-DD') : undefined,
			start: new Date(finished.startedAt),
			end: new Date(end),
			minutes: pausedMs >= 60_000 ? finished.minutes : undefined,
			label: 'Focus',
			link,
			task: task ? logTaskText(task.text) : undefined,
		});
		await appendLogLine(this.app, logNote, this.settings.logHeading, line);
	}

	/** Once a day per reason: say why the line went to the fallback note instead of today's daily note. */
	private noticeFallback(reason: FallbackReason, template?: string): void {
		if (reason === 'daily-notes-off') return; // Expected; the setting says so.
		const key = `${reason}:${todayKey()}`;
		if (this.fallbackNoticed.has(key)) return;
		this.fallbackNoticed.add(key);
		const where = `"${FALLBACK_LOG_NOTE.replace(/\.md$/, '')}"`;
		new Notice(
			reason === 'template-missing'
				? `Kiri could not find your daily note template (${template ?? ''}), so it did not create today's note. The block was logged in ${where}.`
				: `Today's daily note does not exist yet, so the block was logged in ${where}. Open today's note first, or turn on "Create the daily note if it is missing" in Kiri's settings.`,
		);
	}

	private async updateTask(current: TaskItem | null, minutes: number): Promise<void> {
		if (!current) return;
		// A switch during the block may still be adding time to this line.
		if (this.pendingSpentWrites > 0) await this.spentWrites;
		const task = this.latestLine(current);
		let ref: TaskItem = task;

		const { taskCounter, writeSpent } = this.settings;
		// A task whose whole block went to tasks finished during it gets no count and no time.
		if ((taskCounter || writeSpent) && minutes > 0) {
			// One atomic edit for both fields. The line is matched by its exact old text,
			// so the same block can never be added twice.
			const skipped: string[] = [];
			const updated = await updateTaskLine(this.app, ref, (line) => {
				let next = line;
				if (taskCounter) {
					if (hasUnreadableCounter(next)) skipped.push('kiri');
					else next = incrementCounter(next) ?? next;
				}
				if (writeSpent) {
					if (hasUnreadableSpent(next)) skipped.push('spent');
					else next = addSpent(next, minutes) ?? next;
				}
				return next;
			});
			for (const field of skipped) this.warnUnreadableField(field);
			if (updated) {
				ref = atPlace({ ...ref, raw: updated.raw, text: parseTaskLine(updated.raw)?.text ?? ref.text }, updated.line, {
					copy: updated.copy ?? 0,
					copies: updated.copies ?? 1,
				});
				this.followTask(task, ref);
			} else {
				new Notice(NOT_FOUND_TO_UPDATE);
			}
		}

		if (this.settings.askMarkDone && (await askMarkDone(this.app, plainTaskText(ref.text) || ref.text))) {
			const done = await markTaskDone(this.app, ref);
			if (done) {
				if (this.picked && (sameTask(this.picked, task) || sameTask(this.picked, ref))) this.picked = null;
				if (this.isOnToday(ref)) this.setToday(removeTask(this.today.items, ref));
			} else {
				new Notice(NOT_FOUND_TO_MARK);
			}
		}
	}

	/** Point the picked task or the Today item at the line Kiri just edited. */
	private followTask(old: TaskItem, next: TaskItem): void {
		if (this.picked && sameTask(this.picked, old)) this.picked = next;
		if (this.isOnToday(old)) this.setToday(replaceTask(this.today.items, old, next));
	}

	/** Once per session and field: say why Kiri left a field the user wrote alone. */
	private warnUnreadableField(field: string): void {
		if (this.warnedFields.has(field)) return;
		this.warnedFields.add(field);
		new Notice(
			field === 'spent'
				? 'Kiri could not read the [spent:: ...] value on this task, so it left it as it is. Write it like 1h 30m to let Kiri add to it.'
				: 'Kiri could not read the [kiri:: ...] value on this task, so it left it as it is. Use a whole number to let Kiri count.',
		);
	}

	/**
	 * Save the block in progress (and the cycle, a waiting break and the picked
	 * task) on this device, so it survives closing Obsidian, a reload or an
	 * update. Device storage is not synced, so a block never moves to another
	 * device. Without device storage (Obsidian before 1.8.7) nothing is saved.
	 */
	private saveBlock(): void {
		// Not before the saved block was read back, or a save during loading would erase it.
		if (!this.device || !this.blockRestored) return;
		const idle = this.timer.phase === 'idle' && !this.pendingBreak && !this.picked && this.cycle.completed === 0;
		const block: SavedBlock | null = idle
			? null
			: {
					timer: this.timer,
					split: this.split,
					cycle: this.cycle,
					longBreak: this.longBreak,
					pendingBreak: this.pendingBreak,
					autoBlocks: this.autoBlocks,
					picked: this.picked,
					hint: this.hint,
				};
		const json = JSON.stringify(block);
		if (json === this.savedBlockJson) return;
		this.savedBlockJson = json;
		try {
			this.device.save(BLOCK_KEY, block);
		} catch (err) {
			console.error('Kiri: could not save the running block', err);
		}
	}

	/** Take back the block saved when Obsidian last closed. Returns true when a block was running or paused. */
	private restoreBlock(): boolean {
		this.blockRestored = true;
		let saved: SavedBlock | null = null;
		try {
			saved = parseSavedBlock(this.device?.load(BLOCK_KEY));
		} catch {
			saved = null;
		}
		this.savedBlockJson = JSON.stringify(saved);
		if (!saved) return false;
		this.cycle = saved.cycle;
		this.pendingBreak = saved.pendingBreak;
		this.autoBlocks = saved.autoBlocks;
		this.picked = this.today.items.length > 0 ? null : saved.picked;
		this.hint = saved.hint;
		if (saved.timer.phase === 'idle') return false;
		this.timer = saved.timer;
		this.longBreak = saved.timer.phase === 'break' && saved.longBreak;
		this.split = saved.timer.phase === 'focus' ? saved.split : NO_SPLIT;
		return true;
	}

	/**
	 * After a restored block: say so, and start the sound again if it still runs.
	 * A block that ended while Obsidian was closed is finished by the first tick
	 * (logged with its own end time, after the sync wait).
	 */
	private resumeRestored(): void {
		const { phase, running } = this.timer;
		if (isFinished(this.timer, Date.now())) return;
		const left = formatCountdown(this.remaining());
		if (phase === 'focus') {
			new Notice(running ? `Kiri resumed your focus block (${left} left).` : `Your focus block is paused (${left} left).`);
			if (running) this.playChosenSound();
		} else if (phase === 'break' && running) {
			new Notice(`Kiri resumed your break (${left} left).`);
		}
		this.notify();
	}

	private updateStatusBar(): void {
		const el = this.statusEl;
		if (!el) return;
		const { phase, running } = this.timer;
		el.toggleClass('kiri-hidden', phase === 'idle');
		if (phase === 'idle') return;
		const time = formatCountdown(this.remaining());
		const label = phase === 'break' ? `Kiri break ${time}` : `Kiri ${time}`;
		el.setText(running ? label : `${label} (paused)`);
	}

	/**
	 * Tick twice a second while a block or break runs (or is paused), and once
	 * a minute when idle, which is enough for the midnight reset. Saves battery
	 * on phones when Kiri is not in use.
	 */
	private scheduleTicks(): void {
		if (this.unloaded) return;
		const ms = this.timer.phase === 'idle' ? IDLE_TICK_MS : ACTIVE_TICK_MS;
		if (this.ticker?.ms === ms) return;
		if (this.ticker) window.clearInterval(this.ticker.id);
		const id = window.setInterval(() => this.tick(), ms);
		this.registerInterval(id);
		this.ticker = { id, ms };
	}

	/** The current tick period in ms (for tests). */
	get tickPeriod(): number | null {
		return this.ticker?.ms ?? null;
	}

	notify(): void {
		if (!this.unloaded) {
			this.saveBlock();
			this.scheduleTicks();
		}
		this.updateStatusBar();
		for (const listener of this.listeners) listener('change');
	}
}

/**
 * Obsidian's vault-specific local storage on this device (1.8.7 and later),
 * else null. The account record and unsent blocks live there, not in the
 * synced data.json.
 */
function deviceStoreOf(app: App): DeviceStore | null {
	if (!requireApiVersion('1.8.7') || typeof app.loadLocalStorage !== 'function') return null;
	return {
		load: (key) => app.loadLocalStorage(key) as unknown,
		save: (key, value) => app.saveLocalStorage(key, value),
	};
}

/** Obsidian's secret storage when this version has it (1.11.4 and later), else null. */
function secretStorageOf(app: App): SecretStore | null {
	if (!requireApiVersion('1.11.4')) return null;
	return app.secretStorage ?? null;
}

/** The open task on the cursor's line, as a task item, or null (also in a Kanban board). */
function taskAtCursor(app: App, editor: Editor, info: MarkdownFileInfo): TaskItem | null {
	const file = info.file;
	if (!file || isKanbanBoard(app, file)) return null;
	const line = editor.getCursor().line;
	const raw = editor.getLine(line);
	if (!isOpenTask(raw)) return null;
	// Only a task Obsidian itself sees as one: not a `- [ ]` line inside a code block or a template example.
	const listItems = app.metadataCache.getFileCache(file)?.listItems ?? [];
	if (!listItems.some((i) => i.task === ' ' && i.position.start.line === line)) return null;
	const parsed = parseTaskLine(raw);
	if (!parsed || parsed.text.trim().length === 0) return null;
	const task: TaskItem = { path: file.path, line, raw, text: parsed.text, noteName: file.basename };
	return atPlace(task, line, copyOf(splitLines(editor.getValue()).lines, line));
}

/** Identifies one task line: its note and its exact text. */
function lineKey(task: { path: string; raw: string }): string {
	return `${task.path}\n${task.raw}`;
}
