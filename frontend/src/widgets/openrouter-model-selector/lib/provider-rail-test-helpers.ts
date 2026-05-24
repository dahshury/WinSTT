import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/shared/lib/cn";

interface PartitionResult {
	favoriteList: string[];
	hasBoth: boolean;
	nonFavoriteList: string[];
}

export function partitionByFavorites(
	providers: string[],
	favoritesSet: Set<string>
): PartitionResult {
	const favoriteList = providers.filter((p) => favoritesSet.has(p));
	const nonFavoriteList = providers.filter((p) => !favoritesSet.has(p));
	const hasBoth = Math.min(favoriteList.length, nonFavoriteList.length) > 0;
	return { favoriteList, nonFavoriteList, hasBoth };
}

interface ScrollState {
	canScrollDown: boolean;
	canScrollUp: boolean;
}

export function readScrollState(viewport: HTMLDivElement): ScrollState {
	const top = viewport.scrollTop;
	const max = viewport.scrollHeight - viewport.clientHeight;
	return {
		canScrollUp: top > 1,
		canScrollDown: max - top > 1,
	};
}

export const SCROLL_STEP_PX = 180;
export const WHEEL_DEBOUNCE_MS = 200;

export function applyWheelScroll(el: HTMLDivElement, event: WheelEvent): void {
	event.preventDefault();
	const direction = Math.sign(event.deltaY) || 1;
	el.scrollBy({ top: direction * SCROLL_STEP_PX, behavior: "smooth" });
}

export function isHorizontalWheel(event: WheelEvent): boolean {
	return Math.abs(event.deltaX) > Math.abs(event.deltaY);
}

/**
 * Determine whether a wheel event should be debounced (suppressed) given
 * the current timestamp and the locked-until timestamp.
 * Returns the updated lockedUntil value (unchanged if event is suppressed or horizontal).
 */
export function applyWheelDebounce(
	event: WheelEvent,
	el: HTMLDivElement,
	now: number,
	lockedUntil: number,
	debounceMs: number
): { handled: boolean; nextLockedUntil: number } {
	if (isHorizontalWheel(event)) {
		return { handled: false, nextLockedUntil: lockedUntil };
	}
	if (now < lockedUntil) {
		event.preventDefault();
		return { handled: false, nextLockedUntil: lockedUntil };
	}
	applyWheelScroll(el, event);
	return { handled: true, nextLockedUntil: now + debounceMs };
}

export function shouldAutoScroll(
	autoScrollEnabled: boolean,
	activeProvider: string | null,
	favoritesSet: Set<string>
): boolean {
	if (!autoScrollEnabled) {
		return false;
	}
	if (!activeProvider) {
		return false;
	}
	return !favoritesSet.has(activeProvider);
}

export function scrollActiveIntoView(el: HTMLDivElement, activeProvider: string): void {
	const tile = el.querySelector<HTMLElement>(`[data-provider="${CSS.escape(activeProvider)}"]`);
	if (tile) {
		tile.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}
}

export const SCROLL_BUTTON_CONFIG = {
	up: {
		icon: ArrowUp01Icon,
		label: "Scroll providers up",
		gradientClass: "top-0 bg-gradient-to-b from-surface-elevated/95 to-transparent",
	},
	down: {
		icon: ArrowDown01Icon,
		label: "Scroll providers down",
		gradientClass: "bottom-0 bg-gradient-to-t from-surface-elevated/95 to-transparent",
	},
} as const;

export function scrollRefByAmount(el: HTMLDivElement | null, delta: number): void {
	if (el) {
		el.scrollBy({ top: delta, behavior: "smooth" });
	}
}

export function getTileButtonClassName(isActive: boolean): string {
	const activeClasses = "border-accent/40 bg-accent/15 text-accent shadow-sm";
	const inactiveClasses =
		"border-transparent text-foreground-muted hover:bg-surface-hover hover:text-foreground";
	return cn(
		"flex h-11 w-11 items-center justify-center rounded-md border transition-colors",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
		isActive ? activeClasses : inactiveClasses
	);
}

export function getFavoriteButtonClassName(isFavorite: boolean): string {
	const favoriteClasses = "text-amber-500 opacity-100";
	const nonFavoriteClasses =
		"text-foreground-muted opacity-0 focus-visible:opacity-100 group-hover:opacity-100";
	return cn(
		"absolute -end-1 -top-1 z-10 flex size-6 items-center justify-center rounded-full border border-border bg-surface shadow-sm transition-opacity",
		isFavorite ? favoriteClasses : nonFavoriteClasses
	);
}

export function getFavoriteAriaLabel(label: string, isFavorite: boolean): string {
	const prefix = isFavorite ? "Unfavorite" : "Favorite";
	return `${prefix} ${label}`;
}

export function handleFavoriteClick(event: React.MouseEvent, onToggle: () => void): void {
	event.preventDefault();
	event.stopPropagation();
	onToggle();
}

export const __provider_rail_test_helpers__ = {
	partitionByFavorites,
	readScrollState,
	applyWheelScroll,
	isHorizontalWheel,
	applyWheelDebounce,
	scrollRefByAmount,
	shouldAutoScroll,
	scrollActiveIntoView,
	getTileButtonClassName,
	getFavoriteButtonClassName,
	getFavoriteAriaLabel,
	handleFavoriteClick,
	SCROLL_BUTTON_CONFIG,
};
