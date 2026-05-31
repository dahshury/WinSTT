/**
 * Mirror of Base UI's `REASONS` enum (`@base-ui/react` internals at
 * ``packages/react/src/internals/reason-parts.js``). Re-exported as a
 * literal union because Base UI does not publish this enum, but
 * Combobox / Popover / Dialog all forward these strings on every
 * ``onOpenChange`` event's ``eventDetails.reason``.
 *
 * Keep this list in sync with upstream — search for ``reason-parts.js``
 * inside ``node_modules/@base-ui/react/`` if Base UI ships new reasons.
 */
export type ComboboxCloseReason =
	| "none"
	| "trigger-press"
	| "trigger-hover"
	| "trigger-focus"
	| "outside-press"
	| "item-press"
	| "close-press"
	| "link-press"
	| "clear-press"
	| "chip-remove-press"
	| "track-press"
	| "increment-press"
	| "decrement-press"
	| "input-change"
	| "input-clear"
	| "input-blur"
	| "input-paste"
	| "input-press"
	| "focus-out"
	| "escape-key"
	| "close-watcher"
	| "list-navigation"
	| "keyboard"
	| "pointer"
	| "drag"
	| "wheel"
	| "scrub"
	| "cancel-open"
	| "sibling-open"
	| "disabled"
	| "missing"
	| "initial"
	| "imperative-action"
	| "swipe"
	| "window-resize";

/**
 * Narrow Base UI's ``onOpenChange(next, eventDetails)`` second argument
 * down to its ``reason`` slot. Returns ``undefined`` when ``eventDetails``
 * is missing or doesn't carry a reason — callers should treat that as
 * "no information, behave as a generic close".
 */
export function extractCloseReason(eventDetails: unknown): ComboboxCloseReason | undefined {
	if (eventDetails === null || typeof eventDetails !== "object") {
		return;
	}
	const reason = (eventDetails as { reason?: unknown }).reason;
	return typeof reason === "string" ? (reason as ComboboxCloseReason) : undefined;
}
