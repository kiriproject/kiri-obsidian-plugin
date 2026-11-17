import { type App, Modal, Setting } from 'obsidian';

/** Ask "Mark task done?" and resolve to the answer. Closing the modal counts as no. */
export function askMarkDone(app: App, taskText: string): Promise<boolean> {
	return new Promise((resolve) => {
		new MarkDoneModal(app, taskText, resolve).open();
	});
}

class MarkDoneModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly taskText: string,
		private readonly resolve: (yes: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Mark task done?');
		this.contentEl.createEl('p', { text: this.taskText, cls: 'kiri-modal-task' });
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText('Mark done')
					.setCta()
					.onClick(() => this.answer(true)),
			)
			.addButton((b) => b.setButtonText('Not yet').onClick(() => this.answer(false)));
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(false);
	}

	private answer(yes: boolean): void {
		this.answered = true;
		this.resolve(yes);
		this.close();
	}
}
