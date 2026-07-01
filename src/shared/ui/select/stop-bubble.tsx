import type { ReactNode } from "react";

/**
 * Eats pointer/keyboard events so an interactive control rendered *inside* a
 * combobox/menu row doesn't reach Base UI's input/item handlers (which would
 * otherwise toggle the popup or commit/select the row).
 *
 * Shared by every picker in this folder family (`Select`, `SearchableSelect`,
 * `CreatableCombobox`, `EditableListCombobox`) — preview buttons, inline
 * delete/edit controls, etc.
 *
 * Must use React's synthetic `onClick` (not `addEventListener`) so that
 * `stopPropagation` runs AFTER the inner button's React `onClick` has fired at
 * the document-root delegated handler. A native `addEventListener` fires during
 * the DOM bubble phase BEFORE the event reaches React's root — stopping it
 * there silently drops the click from React entirely.
 */
function swallowEvent(e: { stopPropagation: () => void }): void {
	e.stopPropagation();
}

export function StopBubble({
	children,
	className,
}: {
	children: ReactNode;
	className?: string | undefined;
}) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: role="toolbar" IS interactive per WAI-ARIA, and this shim's only job is to stop pointer/keyboard events from bubbling out to the parent listbox row so an inner control (preview button, etc.) can be activated without selecting the row.
		<div
			className={className}
			onClick={swallowEvent}
			onKeyDown={swallowEvent}
			onMouseDown={swallowEvent}
			onPointerDown={swallowEvent}
			role="toolbar"
			tabIndex={-1}
		>
			{children}
		</div>
	);
}
