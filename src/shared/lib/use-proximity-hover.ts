import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";

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

function rectsEqual(
	left: Record<number, ProximityRect>,
	right: Record<number, ProximityRect>,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	return leftKeys.every((key) => {
		const index = Number(key);
		const a = left[index];
		const b = right[index];
		return (
			a !== undefined &&
			b !== undefined &&
			a.top === b.top &&
			a.left === b.left &&
			a.width === b.width &&
			a.height === b.height
		);
	});
}

function updateRectsIfChanged(
	setItemRects: Dispatch<SetStateAction<Record<number, ProximityRect>>>,
	next: Record<number, ProximityRect>,
): void {
	setItemRects((prev) => (rectsEqual(prev, next) ? prev : next));
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
	// Stable, mutated-in-place collection of registered elements. Created once
	// via `useState`'s lazy initializer so it survives re-renders without
	// allocating a fresh `Map` each render.
	const [items] = useState<Map<number, HTMLElement>>(
		() => new Map<number, HTMLElement>(),
	);
	const sessionRef = useRef(0);
	const rectsRef = useRef<Record<number, ProximityRect>>({});

	// Mirror the latest `itemRects` into a ref so the `onMouseMove` event
	// handler can read fresh rects without re-subscribing.
	useEffect(() => {
		rectsRef.current = itemRects;
	}, [itemRects]);

	// Consumers depend on this in effects; create it once from stable refs/state
	// so measuring rows does not schedule another measurement on the next render.
	const [measureItems] = useState(() => () => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const containerRect = container.getBoundingClientRect();
		const next: Record<number, ProximityRect> = {};
		for (const [idx, el] of items.entries()) {
			next[idx] = rectFromElement(el, containerRect);
		}
		updateRectsIfChanged(setItemRects, next);
	});

	function registerItem(index: number, element: HTMLElement | null) {
		if (element) {
			items.set(index, element);
		} else {
			items.delete(index);
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
			for (const [idx, el] of items.entries()) {
				next[idx] = rectFromElement(el, rect);
			}
			updateRectsIfChanged(setItemRects, next);
		};
		const ro = new ResizeObserver(measure);
		ro.observe(container);
		for (const el of items.values()) {
			ro.observe(el);
		}
		return () => ro.disconnect();
	}, [containerRef, items]);

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
