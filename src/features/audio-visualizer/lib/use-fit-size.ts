import { type RefObject, useEffect, useState } from "react";
import type { VisualizerSize } from "./audio-visualizer";

// Largest dimension the variant occupies at each size. Mirrors the heights in
// the cva `*Variants` of each visualizer (icon 24, sm 56, md 112, lg 224, xl 448).
const SIZE_THRESHOLDS: ReadonlyArray<readonly [VisualizerSize, number]> = [
	["xl", 448],
	["lg", 224],
	["md", 112],
	["sm", 56],
	["icon", 24],
];

/**
 * Picks the largest visualizer size that fits inside the observed element.
 * Uses ResizeObserver to react to window/layout changes.
 */
export function useFitSize(ref: RefObject<HTMLElement | null>): VisualizerSize {
	const [size, setSize] = useState<VisualizerSize>("icon");

	useEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}

		const update = () => {
			const min = Math.min(el.clientWidth, el.clientHeight);
			const next =
				SIZE_THRESHOLDS.find(([, threshold]) => min >= threshold)?.[0] ??
				"icon";
			setSize((prev) => (prev === next ? prev : next));
		};

		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);

	return size;
}
