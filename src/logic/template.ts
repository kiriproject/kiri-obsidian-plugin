/**
 * Fill the placeholders the core Daily notes plugin supports in templates:
 * {{title}}, {{date}}, {{time}}, {{date:FORMAT}} and {{time:FORMAT}}.
 * `format` formats "now" with a moment-style pattern; it is passed in to keep this pure.
 */
export function applyDailyTemplate(
	template: string,
	title: string,
	dateFormat: string,
	format: (pattern: string) => string,
): string {
	return template
		.replace(/{{\s*title\s*}}/gi, title)
		.replace(/{{\s*(date|time)\s*(?::\s*([^}]*?))?\s*}}/gi, (_whole, kind: string, pattern?: string) => {
			if (pattern && pattern.length > 0) return format(pattern);
			return kind.toLowerCase() === 'date' ? format(dateFormat) : format('HH:mm');
		});
}
