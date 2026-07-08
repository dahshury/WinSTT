import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";

/**
 * Base-UI port of DiceUI's `usePending` (itself modelled on React Aria's
 * Button pending state). Manages the *behavioural* half of a pending control:
 * the ARIA/data attributes screen readers and CSS key off, plus capture-phase
 * guards that swallow interaction while the async work is in flight.
 *
 * It is deliberately visual-free — pair it with {@link PendingBadge} (or your
 * own spinner) for the *visible* half. The one WinSTT deviation from the
 * original: no Radix `Slot`. Consumers either spread `pendingProps` onto a DOM
 * element directly or hand it to the {@link Pending} wrapper, which merges it
 * via Base UI's `useRender`.
 */

export interface UsePendingOptions {
	/** When `true`, the element is marked busy and interaction is suppressed. */
	isPending?: boolean | undefined;
}

/** Minimal shape shared by the React synthetic events we guard. */
type GuardableEvent = Pick<Event, "preventDefault" | "stopPropagation">;

/**
 * Props spread onto the target element. Present only while pending — when
 * settled the object is empty so the element behaves exactly as if the utility
 * were absent (no stray `data-*`, no dangling handlers). Guards run in the
 * capture phase so they win over the child's own bubble-phase handlers
 * regardless of whether the child is a DOM node or a Base-UI component.
 */
// A `type` (not `interface`) so it stays assignable to `useRender`'s
// `Record<string, unknown>` props param — TS gives object-literal type aliases
// an implicit index signature, interfaces none.
export type PendingProps = {
	"aria-busy"?: true;
	"aria-disabled"?: true;
	"data-disabled"?: "";
	"data-pending"?: "";
	onClickCapture?: (event: MouseEvent) => void;
	onKeyDownCapture?: (event: KeyboardEvent) => void;
	onKeyUpCapture?: (event: KeyboardEvent) => void;
	onPointerDownCapture?: (event: PointerEvent) => void;
	onPointerUpCapture?: (event: PointerEvent) => void;
};

export interface UsePendingReturn {
	/** Resolved pending flag (defaults to `false`). */
	isPending: boolean;
	/** Props to spread on the interactive element — spread them **last**. */
	pendingProps: PendingProps;
}

function suppress(event: GuardableEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

export function usePending(options: UsePendingOptions = {}): UsePendingReturn {
	const isPending = options.isPending ?? false;

	if (!isPending) {
		return { isPending: false, pendingProps: {} };
	}

	return {
		isPending: true,
		pendingProps: {
			"aria-busy": true,
			"aria-disabled": true,
			"data-pending": "",
			"data-disabled": "",
			// Focus is intentionally preserved (no tabIndex change) — only the
			// interactions themselves are swallowed, matching the source utility.
			onClickCapture: suppress,
			onPointerDownCapture: suppress,
			onPointerUpCapture: suppress,
			onKeyDownCapture: suppress,
			onKeyUpCapture: suppress,
		},
	};
}
