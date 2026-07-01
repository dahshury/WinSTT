/**
 * Truncate `text` to at most `max` characters, appending an ellipsis when the
 * string is clipped. Trailing whitespace before the ellipsis is trimmed so the
 * result reads cleanly (e.g. "hello …" → "hello…"). Strings already within the
 * limit are returned unchanged.
 */
export function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max).trimEnd()}…`;
}
