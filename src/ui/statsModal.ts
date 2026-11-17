import { type App, DropdownComponent, Modal } from 'obsidian';
import { computeStats, type FocusEntry, minutesByNote, type StatsRange } from '../logic/stats';
import { formatKiris } from '../account/api';
import { formatDurationText } from '../logic/taskLine';
import { collectFocusEntries, todayKey } from '../vault/stats';

const RANGE_LABELS: Record<StatsRange, string> = {
	week: 'This week',
	month: 'Last 30 days',
	all: 'All time',
};

/** Focus stats read from the focus log lines in your notes. Nothing is sent anywhere. */
export class StatsModal extends Modal {
	private entries: FocusEntry[] = [];
	private range: StatsRange = 'week';
	private listEl: HTMLElement | null = null;

	/** @param kirisTotal Kiris on the connected Kiri account; null hides the tile. */
	constructor(
		app: App,
		private readonly kirisTotal: number | null = null,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.setTitle('Focus stats');
		const { contentEl } = this;
		contentEl.addClass('kiri-stats');
		const loading = contentEl.createDiv({ cls: 'kiri-muted', text: 'Reading your focus log…' });
		try {
			this.entries = await collectFocusEntries(this.app);
		} catch {
			loading.setText('Kiri could not read your focus log.');
			return;
		}
		loading.remove();
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		const today = todayKey();
		const stats = computeStats(this.entries, today);

		const tiles = contentEl.createDiv({ cls: 'kiri-stat-tiles' });
		this.tile(tiles, 'Today', formatDurationText(stats.today.minutes), blocks(stats.today.blocks));
		this.tile(tiles, 'This week', formatDurationText(stats.week.minutes), blocks(stats.week.blocks));
		this.tile(tiles, 'Streak', stats.streak === 1 ? '1 day' : `${stats.streak} days`, 'Days in a row with a block');
		if (this.kirisTotal !== null) this.tile(tiles, 'Kiris', formatKiris(this.kirisTotal), 'On your Kiri account');

		const head = contentEl.createDiv({ cls: 'kiri-row kiri-stats-head' });
		head.createDiv({ cls: 'kiri-label', text: 'Time per note' });
		new DropdownComponent(head)
			.addOptions(RANGE_LABELS)
			.setValue(this.range)
			.onChange((value) => {
				this.range = value as StatsRange;
				this.renderList();
			});
		this.listEl = contentEl.createDiv({ cls: 'kiri-stats-list' });
		this.renderList();

		contentEl.createDiv({
			cls: 'kiri-muted',
			text: 'Counted from the focus log lines in your daily notes. Edit or delete a line to change the numbers.',
		});
	}

	private tile(parent: HTMLElement, label: string, value: string, sub: string): void {
		const el = parent.createDiv({ cls: 'kiri-stat-tile' });
		el.createDiv({ cls: 'kiri-label', text: label });
		el.createDiv({ cls: 'kiri-stat-value', text: value });
		el.createDiv({ cls: 'kiri-note-name', text: sub });
	}

	private renderList(): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();
		const rows = minutesByNote(this.entries, this.range, todayKey());
		if (rows.length === 0) {
			el.createDiv({ cls: 'kiri-muted', text: 'No focus blocks in this period yet.' });
			return;
		}
		const max = Math.max(...rows.map((r) => r.minutes), 1);
		for (const row of rows) {
			const item = el.createDiv({ cls: 'kiri-stats-row' });
			const top = item.createDiv({ cls: 'kiri-stats-row-top' });
			top.createSpan({ text: row.name ?? 'No note', cls: row.name ? '' : 'kiri-note-name' });
			top.createSpan({ cls: 'kiri-stats-minutes', text: `${formatDurationText(row.minutes)} · ${blocks(row.blocks)}` });
			const bar = item.createEl('progress', { cls: 'kiri-stats-bar' });
			bar.max = max;
			bar.value = row.minutes;
		}
	}
}

function blocks(n: number): string {
	return n === 1 ? '1 block' : `${n} blocks`;
}
