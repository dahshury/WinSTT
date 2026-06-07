import { type RefObject, useEffect, useRef, useState } from "react";

interface ProximityRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

interface ProximityHandlers {
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	onMouseMove: (e: { clientY: number }) => void;
}

export interface UseProximityHover {
	activeIndex: number | null;
	handlers: ProximityHandlers;
	itemRects: Record<number, ProximityRect>;
	measureItems: () => void;
	registerItem: (index: number, element: HTMLElement | null) => void;
	sessionRef: RefObject<number>;
	setActiveIndex: (index: number | null) => void;
}

const ITEM_BUFFER_PX = 2;

function rectFromElement(el: HTMLElement, container: DOMRect): ProximityRect {
	const r = el.getBoundingClientRect();
	return {
		top: r.top - container.top,
		left: r.left - container.left,
		width: r.width,
		height: r.height,
	};
}

/**
 * True iff `localY` falls inside `rect`'s vertical span widened by
 * `ITEM_BUFFER_PX` on each end. Extracted so `findActiveIndex` is a flat
 * `for+return` loop body (CC stays low).
 */
function isWithinBufferedRange(localY: number, rect: ProximityRect): boolean {
	const lower = rect.top - ITEM_BUFFER_PX;
	const upper = rect.top + rect.height + ITEM_BUFFER_PX;
	return localY >= lower && localY < upper;
}

export function useProximityHover(
	containerRef: RefObject<HTMLElement | null>,
): UseProximityHover {
	const [activeIndex, setActiveIndex] = useState<number | null>(null);
	const [itemRects, setItemRects] = useState<Record<number, ProximityRect>>({});
	const itemsRef = useRef<Map<number, HTMLElement>>(new Map());
	const sessionRef = useRef(0);
	const rectsRef = useRef<Record<number, ProximityRect>>({});

	rectsRef.current = itemRects;

	// `measureItems` is exposed as a *stable* function reference (memoized once
	// via `useRef` at mount) so consumers can depend on it in `useEffect` deps
	// without triggering an effect-thrash loop. The stable wrapper reads
	// `containerRef` and `itemsRef` (both refs, stable) on each invocation —
	// no captured closure value goes stale.
	const measureItemsRef = useRef<() => void>(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const containerRect = container.getBoundingClientRect();
		const next: Record<number, ProximityRect> = {};
		for (const [idx, el] of itemsRef.current.entries()) {
			next[idx] = rectFromElement(el, containerRect);
		}
		setItemRects(next);
	});
	const measureItems = measureItemsRef.current;

	function registerItem(index: number, element: HTMLElement | null) {
		if (element) {
			itemsRef.current.set(index, element);
		} else {
			itemsRef.current.delete(index);
		}
	}

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const measure = () => {
			const rect = container.getBoundingClientRect();
			const next: Record<number, ProximityRect> = {};
			for (const [idx, el] of itemsRef.current.entries()) {
				next[idx] = rectFromElement(el, rect);
			}
			setItemRects(next);
		};
		const ro = new ResizeObserver(measure);
		ro.observe(container);
		for (const el of itemsRef.current.values()) {
			ro.observe(el);
		}
		return () => ro.disconnect();
	}, [containerRef]);

	function findActiveIndex(localY: number): number | null {
		const rects = rectsRef.current;
		for (const [key, rect] of Object.entries(rects)) {
			if (isWithinBufferedRange(localY, rect)) {
				return Number(key);
			}
		}
		return null;
	}

	const handlers: ProximityHandlers = {
		onMouseEnter() {
			sessionRef.current += 1;
			measureItems();
		},
		onMouseMove(e) {
			const container = containerRef.current;
			if (!container) {
				return;
			}
			const rect = container.getBoundingClientRect();
			setActiveIndex(findActiveIndex(e.clientY - rect.top));
		},
		onMouseLeave() {
			setActiveIndex(null);
		},
	};

	return {
		activeIndex,
		handlers,
		itemRects,
		measureItems,
		registerItem,
		sessionRef,
		setActiveIndex,
	};
}
