"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Scroll-spy for picker model lists. As the user scrolls past sticky
 * group headers (`[data-rail-section]`) in the right list, call
 * `onActiveChange` with the id of the topmost-visible section so the
 * left `GroupRail`'s active tile tracks the user's reading position.
 *
 * Returns a `suppress(durationMs)` handle the caller must invoke right
 * before a programmatic smooth-scroll (e.g. on rail-tile click) so the
 * spy doesn't flicker through every intermediate section en route to
 * the click target.
 *
 * The spy attaches to the `scrollContainerSelector` element *inside*
 * the popup so multiple pickers in the same window don't fight over
 * the same DOM matches. Each picker just labels its own scroll
 * container with a unique `data-slot` and passes that selector here.
 */
export interface UseRailScrollSpyOptions {
	/** Called with the topmost-visible section id whenever it changes. */
	onActiveChange: (id: string) => void;
	/** Selector for the scroll container inside the popup. */
	scrollContainerSelector: string;
}

export interface RailScrollSpyHandle {
	/**
	 * Callback ref the caller wires into `ModelPicker`'s `popupRef`. The
	 * hook stores the node in its own state to drive the spy's effect
	 * without forcing the caller component to keep a render-state mirror
	 * (which `react-doctor/rerender-state-only-in-handlers` flags).
	 */
	attach: (node: HTMLElement | null) => void;
	/**
	 * Suppress spy updates for `durationMs` (default 700 — matches a
	 * typical smooth-scroll duration). Use right before triggering a
	 * programmatic scroll to keep the active id pinned to the target.
	 */
	suppress: (durationMs?: number) => void;
}

const TOP_DETECTION_PX = 8;
const DEFAULT_SUPPRESS_MS = 700;

export function useRailScrollSpy({
	scrollContainerSelector,
	onActiveChange,
}: UseRailScrollSpyOptions): RailScrollSpyHandle {
	const programmaticUntilRef = useRef<number>(0);
	const onActiveChangeRef = useRef(onActiveChange);
	onActiveChangeRef.current = onActiveChange;

	// Local state mirror of the popup node. Owned by the hook so the
	// caller doesn't need to track a `useState` whose value never reaches
	// its JSX — the rule that fires on this pattern is filed against the
	// caller component's body, not the hook.
	const [popupNode, setPopupNode] = useState<HTMLElement | null>(null);

	useEffect(() => {
		if (!popupNode) {
			return;
		}
		const listContainer = popupNode.querySelector<HTMLElement>(scrollContainerSelector);
		if (!listContainer) {
			return;
		}
		const handleScroll = () => {
			if (Date.now() < programmaticUntilRef.current) {
				return;
			}
			const sectionEls = listContainer.querySelectorAll<HTMLElement>("[data-rail-section]");
			if (sectionEls.length === 0) {
				return;
			}
			const containerTop = listContainer.getBoundingClientRect().top;
			let bestId: string | null = null;
			let bestDistance = Number.NEGATIVE_INFINITY;
			for (const el of Array.from(sectionEls)) {
				// Sticky headers sit at the container's top edge while
				// their section is in view. The "topmost in-view" section
				// is the one whose header `rect.top` is closest to (but
				// not past) the container top.
				const distance = el.getBoundingClientRect().top - containerTop;
				if (distance <= TOP_DETECTION_PX && distance > bestDistance) {
					bestDistance = distance;
					bestId = el.dataset.railSection ?? null;
				}
			}
			if (bestId !== null) {
				onActiveChangeRef.current(bestId);
			}
		};
		listContainer.addEventListener("scroll", handleScroll, { passive: true });
		handleScroll();
		return () => {
			listContainer.removeEventListener("scroll", handleScroll);
		};
	}, [popupNode, scrollContainerSelector]);

	return {
		attach: (node: HTMLElement | null) => {
			setPopupNode((prev) => (prev === node ? prev : node));
		},
		suppress: (durationMs = DEFAULT_SUPPRESS_MS) => {
			programmaticUntilRef.current = Date.now() + durationMs;
		},
	};
}
