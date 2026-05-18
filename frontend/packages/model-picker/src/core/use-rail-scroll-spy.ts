"use client";

import { useEffect, useRef } from "react";

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
	/** Popup root (the node returned by `ModelPicker`'s `popupRef`). */
	popupNode: HTMLElement | null;
	/** Selector for the scroll container inside the popup. */
	scrollContainerSelector: string;
}

export interface RailScrollSpyHandle {
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
	popupNode,
	scrollContainerSelector,
	onActiveChange,
}: UseRailScrollSpyOptions): RailScrollSpyHandle {
	const programmaticUntilRef = useRef<number>(0);
	const onActiveChangeRef = useRef(onActiveChange);
	onActiveChangeRef.current = onActiveChange;

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
		suppress: (durationMs = DEFAULT_SUPPRESS_MS) => {
			programmaticUntilRef.current = Date.now() + durationMs;
		},
	};
}
