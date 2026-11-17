import { type App, type FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import type { TaskItem } from '../vault/tasks';

/**
 * "Switch task…": a fuzzy picker over tasks (Today's, or the active note's
 * while Today is empty). The task marked current is shown with "now".
 */
export class SwitchTaskModal extends FuzzySuggestModal<TaskItem> {
	constructor(
		app: App,
		private readonly tasks: readonly TaskItem[],
		private readonly current: TaskItem | null,
		private readonly choose: (task: TaskItem) => void,
	) {
		super(app);
		this.setPlaceholder('Switch to a task…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to make it the current task' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
	}

	getItems(): TaskItem[] {
		return [...this.tasks];
	}

	getItemText(task: TaskItem): string {
		return `${task.text} ${task.noteName}`;
	}

	renderSuggestion(match: FuzzyMatch<TaskItem>, el: HTMLElement): void {
		const task = match.item;
		const isCurrent = !!this.current && this.current.path === task.path && this.current.raw === task.raw;
		el.addClass('kiri-switch-suggestion');
		el.createDiv({ text: task.text });
		el.createDiv({ cls: 'kiri-note-name', text: isCurrent ? `${task.noteName} · now` : task.noteName });
	}

	onChooseItem(task: TaskItem): void {
		this.choose(task);
	}
}
