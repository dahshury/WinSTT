import type { IconSvgElement } from "@hugeicons/react";

export interface SwitcherOption<T extends string = string> {
	/** Optional small icon rendered as a corner badge over the option (e.g. a
	 * lock icon to mark a tab that's disabled until some prerequisite is met).
	 * Becomes interactive when `badgeTooltip` or `onBadgeClick` is also
	 * provided — the badge floats above the (possibly disabled) Toggle so
	 * hover/click events reach it regardless of the Toggle's disabled state. */
	badgeIcon?: IconSvgElement;
	/** Optional tooltip shown when the badge is hovered/focused — typically
	 * explains why the option is currently disabled. */
	badgeTooltip?: string;
	/** Optional per-option accent color (hex). When set, the active-segment
	 * indicator fills with this color when the option is selected, and the
	 * unselected label is tinted with the same color. */
	color?: string;
	/** When true the option is dimmed and cannot be selected */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	label: string;
	/** Optional click handler invoked when the badge is pressed. Makes the
	 * badge render as a button instead of a presentational span. */
	onBadgeClick?: () => void;
	value: T;
}
