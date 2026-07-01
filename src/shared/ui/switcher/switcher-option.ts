import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { DemoName } from "@/shared/config/demo-preview";

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
	/** Optional supporting line rendered in the badge tooltip's footer (e.g. an
	 * actionable "add an API key to enable this" hint). */
	badgeTooltipFooter?: string;
	/** Optional per-option accent color (hex). When set, the active-segment
	 * indicator fills with this color when the option is selected, and the
	 * unselected label is tinted with the same color. */
	color?: string;
	/** When true the option is dimmed and cannot be selected */
	disabled?: boolean;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	/** Optional leading icon as an arbitrary node (e.g. a brand-logo SVG with
	 *  `currentColor`). Takes precedence over `icon` when both are set — lets a
	 *  provider toggle show its actual mark instead of a generic glyph. */
	iconNode?: ReactNode;
	label: string;
	/** Optional click handler invoked when the badge is pressed. Makes the
	 * badge render as a button instead of a presentational span. */
	onBadgeClick?: () => void;
	/** When set, hovering this option reveals a short looping demo of it (fetched
	 * on demand from the docs CDN). Lets a multi-option control show one preview
	 * per button instead of one for the whole group. */
	preview?: DemoName;
	/** Optional tooltip shown when the whole option (segment) is hovered. Used
	 * for non-disabled options that still want an explanatory tooltip. */
	tooltip?: string;
	/** Optional supporting line rendered in the option tooltip's footer. */
	tooltipFooter?: string;
	value: T;
}
