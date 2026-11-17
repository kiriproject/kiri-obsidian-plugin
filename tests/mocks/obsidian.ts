// Minimal stand-in for the parts of the Obsidian API used by src/vault and,
// for orchestration tests, src/main.ts. The real `obsidian` package only ships
// type definitions. UI classes are empty shells: the tests drive the plugin, not the view.
import realMoment from 'moment';

export const moment = realMoment;

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export class TFile {
	stat = { mtime: 0, ctime: 0, size: 0 };
	constructor(public path: string) {}
	get basename(): string {
		const name = this.path.split('/').pop() ?? this.path;
		return name.replace(/\.md$/, '');
	}
	get extension(): string {
		return this.path.split('.').pop() ?? '';
	}
}

export class TFolder {
	constructor(public path: string) {}
}

type Handler = (...args: never[]) => unknown;

/** Obsidian's Events, enough for on/offref/trigger. */
export class FakeEvents {
	private handlers = new Map<string, Set<Handler>>();
	on(name: string, fn: Handler): { name: string; fn: Handler; source: FakeEvents } {
		let set = this.handlers.get(name);
		if (!set) this.handlers.set(name, (set = new Set()));
		set.add(fn);
		return { name, fn, source: this };
	}
	offref(ref: { name: string; fn: Handler }): void {
		this.handlers.get(ref.name)?.delete(ref.fn);
	}
	trigger(name: string, ...args: unknown[]): void {
		for (const fn of this.handlers.get(name) ?? []) (fn as (...a: unknown[]) => unknown)(...args);
	}
	count(name: string): number {
		return this.handlers.get(name)?.size ?? 0;
	}
}

/** Messages of every Notice shown, for tests to check. */
export const notices: string[] = [];

export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
	hide(): void {}
}

export const Platform = { isPhone: false, isTablet: false, isMobile: false, isDesktop: true };

/** The Obsidian version the fake app pretends to be. */
export const fakeVersion = { current: '1.10.0' };

export function requireApiVersion(version: string): boolean {
	const parts = (v: string): number[] => v.split('.').map((n) => Number(n));
	const [a, b] = [parts(fakeVersion.current), parts(version)];
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return true;
}

export function debounce<T extends unknown[]>(fn: (...args: T) => unknown): ((...args: T) => void) & { cancel: () => void; run: () => void } {
	let pending: T | null = null;
	const d = (...args: T): void => {
		pending = args;
	};
	d.cancel = () => {
		pending = null;
	};
	d.run = () => {
		const args = pending;
		pending = null;
		if (args) fn(...args);
	};
	return d;
}

export async function requestUrl(): Promise<never> {
	throw new Error('No network in tests');
}

export function setIcon(): void {}

class FakeEl {
	classes = new Set<string>();
	text = '';
	addClass(...c: string[]): void {
		c.forEach((x) => this.classes.add(x));
	}
	removeClass(...c: string[]): void {
		c.forEach((x) => this.classes.delete(x));
	}
	toggleClass(c: string, on: boolean): void {
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	}
	setText(t: string): void {
		this.text = t;
	}
	empty(): void {}
}

export class Plugin {
	/** Event refs registered with registerEvent, removed again by unload(). */
	private refs: { source: FakeEvents; name: string; fn: Handler }[] = [];
	stored: unknown = null;
	constructor(
		public app: FakeApp,
		public manifest: { id: string; dir?: string; version: string },
	) {}
	async loadData(): Promise<unknown> {
		return this.stored === null ? null : JSON.parse(JSON.stringify(this.stored));
	}
	async saveData(data: unknown): Promise<void> {
		this.stored = JSON.parse(JSON.stringify(data));
	}
	registerEvent(ref: { source: FakeEvents; name: string; fn: Handler }): void {
		this.refs.push(ref);
	}
	registerInterval(id: number): number {
		return id;
	}
	registerDomEvent(): void {}
	registerView(): void {}
	addCommand(): void {}
	addRibbonIcon(): void {}
	addSettingTab(): void {}
	addStatusBarItem(): FakeEl {
		return new FakeEl();
	}
	/** What Obsidian does when the plugin is turned off. */
	unload(): void {
		for (const ref of this.refs) ref.source.offref(ref);
		this.refs = [];
		(this as unknown as { onunload?: () => void }).onunload?.();
	}
}

class Shell {
	constructor(..._args: unknown[]) {}
}
export class ItemView extends Shell {}
export class PluginSettingTab extends Shell {}
export class Modal extends Shell {
	open(): void {}
	close(): void {}
}
/** The last fuzzy picker opened, so tests can choose an item. */
export const openedPickers: FuzzySuggestModal<unknown>[] = [];
export abstract class FuzzySuggestModal<T> extends Modal {
	setPlaceholder(_text: string): void {}
	setInstructions(_list: unknown[]): void {}
	abstract getItems(): T[];
	abstract onChooseItem(item: T): void;
	open(): void {
		openedPickers.push(this as unknown as FuzzySuggestModal<unknown>);
	}
}
export class Setting extends Shell {}
export class ButtonComponent extends Shell {}
export class DropdownComponent extends Shell {}
export class SliderComponent extends Shell {}
export class ToggleComponent extends Shell {}

interface ListItem {
	task?: string;
	position: { start: { line: number } };
}

/** An in-memory vault with just enough behaviour for the tests. */
export class FakeApp {
	files = new Map<string, string>();
	folders = new Set<string>();
	internalPlugins: unknown = { getPluginById: () => null };
	plugins: unknown = { enabledPlugins: new Set<string>(), plugins: {} };
	/** Path of the note open in the editor, if any. */
	activeFile: string | null = null;

	/** Obsidian's vault-specific local storage on this device. */
	local = new Map<string, string>();
	loadLocalStorage(key: string): unknown {
		const v = this.local.get(key);
		return v === undefined ? null : (JSON.parse(v) as unknown);
	}
	saveLocalStorage(key: string, data: unknown): void {
		if (data === null || data === undefined) this.local.delete(key);
		else this.local.set(key, JSON.stringify(data));
	}

	vaultEvents = new FakeEvents();
	metadataEvents = new FakeEvents();
	workspaceEvents = new FakeEvents();
	private layoutReady: (() => void)[] = [];

	/** Run what plugins asked to run once the layout is ready. */
	readyLayout(): void {
		const fns = this.layoutReady;
		this.layoutReady = [];
		fns.forEach((fn) => fn());
	}

	/** What Obsidian does after a note's text changed and it parsed the note again. */
	emitChanged(path: string): void {
		this.metadataEvents.trigger('changed', new TFile(path), this.files.get(path) ?? '', {});
	}

	/** Rename a note (or, with `folder`, every note in a folder) and fire the events Obsidian fires. */
	renameFile(oldPath: string, newPath: string, folder = false): void {
		if (!folder) {
			this.files.set(newPath, this.files.get(oldPath) ?? '');
			this.files.delete(oldPath);
			this.vaultEvents.trigger('rename', new TFile(newPath), oldPath);
			return;
		}
		for (const [p, data] of [...this.files]) {
			if (!p.startsWith(`${oldPath}/`)) continue;
			this.files.delete(p);
			this.files.set(`${newPath}/${p.slice(oldPath.length + 1)}`, data);
		}
		this.vaultEvents.trigger('rename', new TFolder(newPath), oldPath);
	}

	deleteFile(path: string): void {
		this.files.delete(path);
		this.vaultEvents.trigger('delete', new TFile(path));
	}

	workspace = {
		onLayoutReady: (fn: () => void): void => {
			this.layoutReady.push(fn);
		},
		on: (name: string, fn: Handler) => this.workspaceEvents.on(name, fn),
		getActiveFile: (): TFile | null => (this.activeFile && this.files.has(this.activeFile) ? new TFile(this.activeFile) : null),
		getLeavesOfType: (): unknown[] => [],
	};

	fileManager = {
		generateMarkdownLink: (f: TFile): string => `[[${f.basename}]]`,
	};

	vault = {
		configDir: '.obsidian',
		adapter: {
			exists: async (): Promise<boolean> => false,
			getResourcePath: (p: string): string => p,
		},
		on: (name: string, fn: Handler) => this.vaultEvents.on(name, fn),
		getFileByPath: (p: string): TFile | null => (this.files.has(p) ? new TFile(p) : null),
		getFolderByPath: (p: string): TFolder | null => (this.folders.has(p) ? new TFolder(p) : null),
		getAbstractFileByPath: (p: string): TFile | null => (this.files.has(p) ? new TFile(p) : null),
		createFolder: async (p: string): Promise<void> => {
			this.folders.add(p);
		},
		create: async (p: string, data: string): Promise<TFile> => {
			if (this.files.has(p)) throw new Error('exists');
			this.files.set(p, data);
			return new TFile(p);
		},
		cachedRead: async (f: TFile): Promise<string> => this.files.get(f.path) ?? '',
		process: async (f: TFile, fn: (data: string) => string): Promise<string> => {
			const next = fn(this.files.get(f.path) ?? '');
			this.files.set(f.path, next);
			return next;
		},
		getMarkdownFiles: (): TFile[] => [...this.files.keys()].filter((p) => p.endsWith('.md')).map((p) => new TFile(p)),
	};

	metadataCache = {
		on: (name: string, fn: Handler) => this.metadataEvents.on(name, fn),
		getFileCache: (f: TFile): { listItems: ListItem[]; frontmatter?: Record<string, string> } => {
			const lines = (this.files.get(f.path) ?? '').split('\n');
			let frontmatter: Record<string, string> | undefined;
			if (lines[0] === '---') {
				const end = lines.indexOf('---', 1);
				if (end > 0) {
					frontmatter = {};
					for (const l of lines.slice(1, end)) {
						const m = /^([^:]+):\s*(.*)$/.exec(l);
						if (m) frontmatter[m[1]!.trim()] = m[2] ?? '';
					}
				}
			}
			const listItems: ListItem[] = [];
			lines.forEach((l, i) => {
				const m = /^\s*(?:>\s*)?(?:[-*+]|\d+[.)])\s+(?:\[(.)\])?/.exec(l);
				if (m) listItems.push({ task: m[1], position: { start: { line: i } } });
			});
			return frontmatter ? { listItems, frontmatter } : { listItems };
		},
	};
}
