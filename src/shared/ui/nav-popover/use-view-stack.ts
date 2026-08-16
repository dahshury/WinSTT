"use client";

import { useState } from "react";

/** Slide direction for the frame: 1 = drilling in, -1 = backing out. */
export type NavDirection = 1 | -1;

export interface ViewStack {
	/** The view currently on screen, or `null` for the root list. */
	activeId: string | null;
	back: () => void;
	/** How deep we are — 0 at the root. */
	depth: number;
	direction: NavDirection;
	push: (id: string) => void;
	/** Jump straight to a view from outside the list (a keyboard shortcut),
	 *  discarding whatever was open rather than stacking on top of it. */
	replace: (id: string) => void;
	reset: () => void;
}

/**
 * Navigation state for a {@link NavPopoverStage}: an ordered stack of view ids
 * plus the direction of the last move, so the frame knows which way to slide.
 *
 * Arbitrarily deep by design — the filter menus only ever go one level down, but
 * the primitive is shared and nothing about it assumes two levels.
 */
export function useViewStack(): ViewStack {
	const [state, setState] = useState<{
		direction: NavDirection;
		stack: readonly string[];
	}>({ direction: 1, stack: [] });

	return {
		activeId: state.stack.at(-1) ?? null,
		back: () =>
			setState((current) => ({
				direction: -1,
				stack: current.stack.slice(0, -1),
			})),
		depth: state.stack.length,
		direction: state.direction,
		push: (id: string) =>
			setState((current) => ({
				direction: 1,
				stack: [...current.stack, id],
			})),
		replace: (id: string) => setState({ direction: 1, stack: [id] }),
		reset: () => setState({ direction: -1, stack: [] }),
	};
}
