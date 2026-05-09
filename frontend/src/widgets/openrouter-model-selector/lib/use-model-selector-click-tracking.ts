"use client";

import { useEffect, useRef } from "react";

/**
 * Tracks the most recent pointerdown target so the combobox `onOpenChange`
 * handler can decide whether to keep the popup open after a click that
 * landed inside a sibling popup (filter menu / submenu).
 */
export function useModelSelectorClickTracking() {
	const lastClickTargetRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const handleClick = (event: PointerEvent) => {
			if (event.target instanceof HTMLElement) {
				lastClickTargetRef.current = event.target;
			}
		};
		document.addEventListener("pointerdown", handleClick, true);
		return () => {
			document.removeEventListener("pointerdown", handleClick, true);
		};
	}, []);

	return lastClickTargetRef;
}
