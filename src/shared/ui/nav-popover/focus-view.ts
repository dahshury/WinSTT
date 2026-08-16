const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Move focus into the view that just slid in.
 *
 * The marker may sit on the control itself (a sort chip) or on a wrapper around
 * a control group (a checkbox list), so both are resolved; a view that marks
 * nothing falls back to its back button, which is always a sensible landing
 * spot because it is the way out.
 */
export function focusViewInitialTarget(container: HTMLElement): void {
	const marked = container.querySelector<HTMLElement>(
		"[data-nav-initial-focus]",
	);
	if (marked === null) {
		container.querySelector<HTMLElement>("[data-nav-back]")?.focus();
		return;
	}
	const target = marked.matches(FOCUSABLE)
		? marked
		: marked.querySelector<HTMLElement>(FOCUSABLE);
	target?.focus();
}

/** Return focus to the root row that opened a view, so backing out lands where
 *  the journey started rather than at the top of the list. */
export function focusNavRow(container: HTMLElement, viewId: string): void {
	const rows = [
		...container.querySelectorAll<HTMLElement>("[data-nav-row-id]"),
	];
	rows.find((row) => row.dataset["navRowId"] === viewId)?.focus();
}
