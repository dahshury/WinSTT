import { useEffect, type RefObject } from "react";
import { scrollModelItemIntoView } from "./model-picker-scroll";

/**
 * Re-centers the active author tile in the group rail. Unlike the model list,
 * the rail's tiles are present the moment the sidebar renders (no virtualized
 * mount to wait for), so this fires in the same frame the picker opens. This is
 * what guarantees the focused author is in view on open — the rail lives in a
 * slot outside `ModelPicker`, so it can't observe the open state itself, and
 * its own `activeId` effect never re-fires when the picker is re-opened with an
 * unchanged selection.
 */
function scrollActiveRailTileIntoView(root: HTMLElement): void {
	const tile = root.querySelector<HTMLElement>(
		'[data-rail-tab="true"][aria-selected="true"]',
	);
	tile?.scrollIntoView({ block: "nearest" });
}

/**
 * Scrolls the currently-selected model row (and the active author rail tile)
 * into view once the popup is open and its collection has rendered. Retries
 * across two animation frames and falls back to a short-lived MutationObserver
 * while the virtualized list mounts rows.
 */
export function useScrollSelectedIntoView(
	popupNodeRef: RefObject<HTMLElement | null>,
	options: {
		effectiveOpen: boolean;
		renderCollection: boolean;
		selectedItemKey?: string | null | undefined;
	},
): void {
	const { effectiveOpen, renderCollection, selectedItemKey } = options;

	useEffect(() => {
		if (!(effectiveOpen && renderCollection)) {
			return;
		}
		const root = popupNodeRef.current;
		if (!root) {
			return;
		}
		let firstFrame = 0;
		let secondFrame = 0;
		let observer: MutationObserver | null = null;
		let observerTimer: ReturnType<typeof setTimeout> | null = null;

		const disconnectObserver = () => {
			observer?.disconnect();
			observer = null;
			if (observerTimer !== null) {
				clearTimeout(observerTimer);
				observerTimer = null;
			}
		};
		const tryScroll = (): boolean => {
			// No selected model → nothing to wait for on the list side; the rail
			// still gets re-centered below.
			if (!selectedItemKey) {
				return true;
			}
			const didScroll = scrollModelItemIntoView(root, selectedItemKey);
			if (didScroll) {
				disconnectObserver();
			}
			return didScroll;
		};

		firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
				scrollActiveRailTileIntoView(root);
				if (tryScroll() || typeof MutationObserver === "undefined") {
					return;
				}
				observer = new MutationObserver(() => {
					tryScroll();
				});
				observer.observe(root, { childList: true, subtree: true });
				observerTimer = setTimeout(disconnectObserver, 1000);
			});
		});

		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
			disconnectObserver();
		};
	}, [popupNodeRef, effectiveOpen, renderCollection, selectedItemKey]);
}
