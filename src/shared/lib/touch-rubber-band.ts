const RUBBER_BAND_MAX_OFFSET = 56;
const RUBBER_BAND_RELEASE_MS = 420;
const RUBBER_BAND_RELEASE_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const RUBBER_BAND_IGNORE_SELECTOR =
	"button, input, textarea, select, [contenteditable='true'], [role='button'], [role='slider'], [data-rubber-band-ignore]";
const RUBBER_BAND_OFF_SELECTOR = "[data-rubber-band='off']";

let installed = false;

function dampenRubberBandDistance(distance: number) {
	const magnitude = Math.abs(distance);
	const offset = RUBBER_BAND_MAX_OFFSET * (1 - 1 / (1 + magnitude * 0.035));
	return Math.sign(distance) * Math.min(RUBBER_BAND_MAX_OFFSET, offset);
}

function isIgnoredTouchTarget(target: EventTarget | null) {
	return (
		target instanceof Element &&
		(target.closest(RUBBER_BAND_IGNORE_SELECTOR) !== null ||
			target.closest(RUBBER_BAND_OFF_SELECTOR) !== null)
	);
}

function getMaxScrollTop(viewport: HTMLElement) {
	return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

function hasScrollableYOverflow(element: HTMLElement) {
	if (element.scrollHeight <= element.clientHeight + 1) {
		return false;
	}
	const overflowY = window.getComputedStyle(element).overflowY;
	return (
		overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay"
	);
}

function findScrollableAncestor(target: EventTarget | null) {
	let node = target instanceof Element ? target : null;
	while (node && node !== document.body) {
		if (node instanceof HTMLElement && hasScrollableYOverflow(node)) {
			return node;
		}
		node = node.parentElement;
	}

	const scrollingElement = document.scrollingElement;
	if (
		scrollingElement instanceof HTMLElement &&
		hasScrollableYOverflow(scrollingElement)
	) {
		return scrollingElement;
	}
	return null;
}

function applyPull(
	target: HTMLElement,
	offset: number,
	release: boolean,
	original: {
		overscrollBehaviorY: string;
		transition: string;
		translate: string;
	},
) {
	target.style.transition = release
		? `translate ${RUBBER_BAND_RELEASE_MS}ms ${RUBBER_BAND_RELEASE_EASING}`
		: "none";
	target.style.translate = `0 ${offset.toFixed(2)}px`;
	if (!release) {
		return;
	}
	window.setTimeout(() => {
		target.style.transition = original.transition;
		target.style.translate = original.translate;
	}, RUBBER_BAND_RELEASE_MS);
}

/**
 * Adds a delegated touch edge-pull to native scrollable elements app-wide.
 * Shared `ScrollArea` instances mark themselves as locally managed, so this
 * installer covers raw `overflow-y-auto` / `overflow-auto` regions.
 */
export function installTouchRubberBand(): void {
	if (installed || typeof document === "undefined") {
		return;
	}
	installed = true;

	let viewport: HTMLElement | null = null;
	let active = false;
	let rubberBanding = false;
	let startedAtTop = false;
	let startedAtBottom = false;
	let startY = 0;
	let boundaryStartY = 0;
	let boundary: "top" | "bottom" | null = null;
	let currentOffset = 0;
	let originalStyles = {
		overscrollBehaviorY: "",
		transition: "",
		translate: "",
	};

	const restoreStyles = () => {
		if (!viewport) {
			return;
		}
		viewport.style.transition = originalStyles.transition;
		viewport.style.translate = originalStyles.translate;
		viewport.style.overscrollBehaviorY = originalStyles.overscrollBehaviorY;
	};

	const resetOffset = (release: boolean) => {
		if (!viewport) {
			return;
		}
		if (currentOffset === 0) {
			restoreStyles();
			return;
		}
		const target = viewport;
		currentOffset = 0;
		applyPull(target, 0, release, originalStyles);
	};

	const stopRubberBanding = () => {
		rubberBanding = false;
		boundary = null;
		boundaryStartY = 0;
		resetOffset(false);
	};

	const onTouchStart = (event: TouchEvent) => {
		if (event.touches.length !== 1 || isIgnoredTouchTarget(event.target)) {
			active = false;
			return;
		}

		const nextViewport = findScrollableAncestor(event.target);
		if (
			!nextViewport ||
			nextViewport.dataset["rubberBandManaged"] === "local"
		) {
			active = false;
			viewport = null;
			return;
		}

		viewport = nextViewport;
		originalStyles = {
			overscrollBehaviorY: viewport.style.overscrollBehaviorY,
			transition: viewport.style.transition,
			translate: viewport.style.translate,
		};
		active = true;
		rubberBanding = false;
		boundary = null;
		currentOffset = 0;
		startY = event.touches[0]?.clientY ?? 0;
		boundaryStartY = startY;
		startedAtTop = viewport.scrollTop <= 0;
		startedAtBottom = viewport.scrollTop >= getMaxScrollTop(viewport) - 1;
		viewport.style.overscrollBehaviorY = "contain";
		viewport.style.transition = "none";
	};

	const onTouchMove = (event: TouchEvent) => {
		if (!active || !viewport || event.touches.length !== 1) {
			return;
		}
		const y = event.touches[0]?.clientY ?? startY;
		const deltaFromStart = y - startY;
		const maxScrollTop = getMaxScrollTop(viewport);

		if (!rubberBanding) {
			if (deltaFromStart > 0 && viewport.scrollTop <= 0) {
				boundary = "top";
				boundaryStartY = startedAtTop ? startY : y;
				rubberBanding = true;
			} else if (deltaFromStart < 0 && viewport.scrollTop >= maxScrollTop - 1) {
				boundary = "bottom";
				boundaryStartY = startedAtBottom ? startY : y;
				rubberBanding = true;
			} else {
				return;
			}
		}

		const signedDistance = y - boundaryStartY;
		const outwardDistance =
			boundary === "top" ? signedDistance : -signedDistance;
		if (outwardDistance <= 0) {
			stopRubberBanding();
			return;
		}

		currentOffset =
			boundary === "top"
				? dampenRubberBandDistance(outwardDistance)
				: -dampenRubberBandDistance(outwardDistance);
		applyPull(viewport, currentOffset, false, originalStyles);
	};

	const onTouchEnd = () => {
		if (!active) {
			return;
		}
		active = false;
		rubberBanding = false;
		boundary = null;
		resetOffset(true);
		viewport = null;
	};

	document.addEventListener("touchstart", onTouchStart, {
		capture: true,
		passive: true,
	});
	document.addEventListener("touchmove", onTouchMove, {
		capture: true,
		passive: true,
	});
	document.addEventListener("touchend", onTouchEnd, {
		capture: true,
		passive: true,
	});
	document.addEventListener("touchcancel", onTouchEnd, {
		capture: true,
		passive: true,
	});
}
