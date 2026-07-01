import { useEffect, type RefObject } from "react";
import { scrollModelItemIntoView } from "./model-picker-scroll";

/**
 * Scrolls the currently-selected model row into view once the popup is open and
 * its collection has rendered. Retries across two animation frames and falls
 * back to a short-lived MutationObserver while the virtualized list mounts rows.
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
		if (!effectiveOpen || !renderCollection || !selectedItemKey) {
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
			const didScroll = scrollModelItemIntoView(root, selectedItemKey);
			if (didScroll) {
				disconnectObserver();
			}
			return didScroll;
		};

		firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => {
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
