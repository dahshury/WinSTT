/**
 * One segment of the History section's clear-actions ButtonGroup. Matches the
 * app's connected-group segments (h-7, px-3, medium xs-tight, neutral idle) and
 * layers the destructive hover on top. The shared `Button` already supplies the
 * flex/centering/focus-ring and `disabled:opacity-40` + `disabled:cursor-default`,
 * and the connected group flattens the radius/border — so a disabled (empty)
 * action reads as a dim, non-interactive segment while an armed one lights red on
 * hover.
 */
export const CLEAR_ACTION_SEGMENT_CLASS =
	"h-7 gap-1.5 px-3 font-medium text-foreground-secondary text-xs-tight transition-colors hover:bg-error hover:text-on-error";
