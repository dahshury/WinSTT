// Decorative accessible name for the checkmark glyph. The <svg> is
// aria-hidden, so screen readers never announce this <title>; it's kept as a
// constant only so it isn't flagged as a user-facing literal.
const CHECK_ICON_TITLE = "Selected";

/**
 * The 10×10 selected-row checkmark glyph used by the combobox pickers
 * (`SearchableSelect`, `CreatableCombobox`) inside their `Combobox.ItemIndicator`.
 */
export function CheckIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="currentcolor"
			height="10"
			role="img"
			viewBox="0 0 10 10"
			width="10"
		>
			<title>{CHECK_ICON_TITLE}</title>
			<path d="M9.16 1.12C9.51 1.35 9.6 1.81 9.38 2.16L5.14 8.66C5.02 8.84 4.82 8.97 4.6 9C4.39 9.02 4.17 8.95 4.01 8.81L1.25 6.31C0.94 6.03 0.92 5.56 1.19 5.25C1.47 4.94 1.95 4.92 2.25 5.2L4.36 7.1L8.12 1.34C8.35 0.99 8.81 0.9 9.16 1.12Z" />
		</svg>
	);
}
