import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { useEffect, useRef } from "react";
import type {
	ComponentPropsWithoutRef,
	CSSProperties,
	ReactNode,
	Ref,
	RefObject,
} from "react";
import { cn } from "@/shared/lib/cn";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<"div"> {
	children: ReactNode;
	/**
	 * Only ever scroll vertically. Overflowing width is clipped instead of
	 * exposing a horizontal scrollbar, and the horizontal scrollbar + corner are
	 * not rendered. The clip is applied via inline `overflowX: hidden` because
	 * Base UI sets `overflow: scroll` inline on the viewport — a class can't beat
	 * an inline style, but `useRenderElement` merges our `style` over its own, so
	 * this wins on the x-axis while vertical scrolling stays intact. Use for
	 * form-like content that should never scroll sideways (e.g. settings tabs).
	 */
	verticalOnly?: boolean;
	/**
	 * Adds an iOS-style edge pull on touch drags when the viewport is already at
	 * its vertical scroll limit. Mouse, wheel, and trackpad scrolling are
	 * unaffected.
	 */
	rubberBandOnTouch?: boolean;
	/**
	 * Extra classes merged onto the vertical scrollbar track. Use to inset it
	 * (e.g. `mt-9` to clear a floating header button, `mb-3` to clear a rounded
	 * corner) so the auto-hiding thumb sits cleanly inside its container instead
	 * of jamming against an edge when it fades in.
	 */
	verticalScrollbarClassName?: string;
	/** Class applied to the inner viewport (the scrollable region). */
	viewportClassName?: string;
	/** Ref to the inner viewport — use for programmatic scrolling. */
	viewportRef?: Ref<HTMLDivElement>;
	/** Inline style applied to the inner viewport. */
	viewportStyle?: CSSProperties;
}

// Auto-hiding overlay thumb: invisible at rest, fades in ONLY while actively
// scrolling (not on hover). Per-side margins (not the `m-*` shorthand) so a
// caller can override a single side through `verticalScrollbarClassName` without
// a shorthand-vs-longhand specificity clash in tailwind-merge.
const VERTICAL_SCROLLBAR_CLASS =
	"mt-0.5 mb-0.5 me-0.5 flex w-1.5 justify-center rounded bg-transparent opacity-0 transition-opacity delay-150 duration-150 data-[scrolling]:opacity-100 data-[scrolling]:delay-0";

const RUBBER_BAND_MAX_OFFSET = 56;
const RUBBER_BAND_RELEASE_MS = 420;
const RUBBER_BAND_RELEASE_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const RUBBER_BAND_IGNORE_SELECTOR =
	"button, input, textarea, select, [contenteditable='true'], [role='button'], [role='slider'], [data-rubber-band-ignore]";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
	if (typeof ref === "function") {
		ref(value);
		return;
	}
	if (ref) {
		ref.current = value;
	}
}

function dampenRubberBandDistance(distance: number) {
	const magnitude = Math.abs(distance);
	const offset = RUBBER_BAND_MAX_OFFSET * (1 - 1 / (1 + magnitude * 0.035));
	return Math.sign(distance) * Math.min(RUBBER_BAND_MAX_OFFSET, offset);
}

function isIgnoredTouchTarget(target: EventTarget | null) {
	return (
		target instanceof Element &&
		target.closest(RUBBER_BAND_IGNORE_SELECTOR) !== null
	);
}

function getMaxScrollTop(viewport: HTMLElement) {
	return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
}

function useTouchRubberBand(
	enabled: boolean,
	viewportRef: RefObject<HTMLDivElement | null>,
	contentRef: RefObject<HTMLDivElement | null>,
) {
	useEffect(() => {
		if (!enabled) {
			return;
		}
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (!viewport || !content) {
			return;
		}

		let active = false;
		let rubberBanding = false;
		let startedAtTop = false;
		let startedAtBottom = false;
		let startY = 0;
		let boundaryStartY = 0;
		let boundary: "top" | "bottom" | null = null;
		let currentOffset = 0;
		let resetTimer: number | undefined;

		const clearResetTimer = () => {
			if (resetTimer !== undefined) {
				window.clearTimeout(resetTimer);
				resetTimer = undefined;
			}
		};

		const setOffset = (offset: number, release: boolean) => {
			currentOffset = offset;
			content.style.transition = release
				? `transform ${RUBBER_BAND_RELEASE_MS}ms ${RUBBER_BAND_RELEASE_EASING}`
				: "none";
			content.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
		};

		const resetOffset = (release: boolean) => {
			clearResetTimer();
			if (currentOffset === 0) {
				content.style.transition = "";
				content.style.transform = "";
				return;
			}
			setOffset(0, release);
			if (release) {
				resetTimer = window.setTimeout(() => {
					content.style.transition = "";
					content.style.transform = "";
					resetTimer = undefined;
				}, RUBBER_BAND_RELEASE_MS);
			}
		};

		const stopRubberBanding = () => {
			rubberBanding = false;
			boundary = null;
			boundaryStartY = 0;
			resetOffset(false);
		};

		const preventNativeOverscroll = (event: TouchEvent) => {
			if (event.cancelable) {
				event.preventDefault();
			}
		};

		const onTouchStart = (event: TouchEvent) => {
			if (event.touches.length !== 1 || isIgnoredTouchTarget(event.target)) {
				active = false;
				return;
			}
			clearResetTimer();
			active = true;
			rubberBanding = false;
			boundary = null;
			startY = event.touches[0]?.clientY ?? 0;
			boundaryStartY = startY;
			startedAtTop = viewport.scrollTop <= 0;
			startedAtBottom = viewport.scrollTop >= getMaxScrollTop(viewport) - 1;
			content.style.transition = "none";
		};

		const onTouchMove = (event: TouchEvent) => {
			if (!active || event.touches.length !== 1) {
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
				} else if (
					deltaFromStart < 0 &&
					viewport.scrollTop >= maxScrollTop - 1
				) {
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

			preventNativeOverscroll(event);
			const offset = dampenRubberBandDistance(outwardDistance);
			setOffset(boundary === "top" ? offset : -offset, false);
		};

		const onTouchEnd = () => {
			active = false;
			rubberBanding = false;
			boundary = null;
			resetOffset(true);
		};

		viewport.addEventListener("touchstart", onTouchStart, { passive: true });
		viewport.addEventListener("touchmove", onTouchMove, { passive: false });
		viewport.addEventListener("touchend", onTouchEnd, { passive: true });
		viewport.addEventListener("touchcancel", onTouchEnd, { passive: true });

		return () => {
			viewport.removeEventListener("touchstart", onTouchStart);
			viewport.removeEventListener("touchmove", onTouchMove);
			viewport.removeEventListener("touchend", onTouchEnd);
			viewport.removeEventListener("touchcancel", onTouchEnd);
			clearResetTimer();
			content.style.transition = "";
			content.style.transform = "";
		};
	}, [contentRef, enabled, viewportRef]);
}

export function ScrollArea({
	children,
	className,
	rubberBandOnTouch = true,
	viewportClassName,
	viewportStyle,
	viewportRef,
	verticalScrollbarClassName,
	verticalOnly = false,
	...rest
}: ScrollAreaProps) {
	const localViewportRef = useRef<HTMLDivElement>(null);
	const rubberBandContentRef = useRef<HTMLDivElement>(null);
	useTouchRubberBand(rubberBandOnTouch, localViewportRef, rubberBandContentRef);
	const resolvedViewportStyle = {
		...(verticalOnly ? { overflowX: "hidden" as const } : null),
		...(rubberBandOnTouch ? { overscrollBehaviorY: "contain" as const } : null),
		...viewportStyle,
	};

	return (
		<BaseScrollArea.Root
			className={cn("relative overflow-hidden", className)}
			{...rest}
		>
			<BaseScrollArea.Viewport
				className={cn(
					"h-full w-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
					viewportClassName,
				)}
				data-rubber-band={rubberBandOnTouch ? undefined : "off"}
				data-rubber-band-managed={rubberBandOnTouch ? "local" : undefined}
				ref={(node) => {
					localViewportRef.current = node;
					assignRef(viewportRef, node);
				}}
				style={resolvedViewportStyle}
			>
				{rubberBandOnTouch ? (
					<div
						className="min-h-full will-change-transform"
						data-rubber-band-content="true"
						ref={rubberBandContentRef}
					>
						{children}
					</div>
				) : (
					children
				)}
			</BaseScrollArea.Viewport>
			<BaseScrollArea.Scrollbar
				className={cn(VERTICAL_SCROLLBAR_CLASS, verticalScrollbarClassName)}
				orientation="vertical"
			>
				<BaseScrollArea.Thumb className="w-full rounded bg-foreground-muted/40" />
			</BaseScrollArea.Scrollbar>
			{verticalOnly ? null : (
				<>
					<BaseScrollArea.Scrollbar
						className="m-0.5 flex h-1.5 items-center rounded bg-transparent opacity-0 transition-opacity delay-150 duration-150 data-[scrolling]:opacity-100 data-[scrolling]:delay-0"
						orientation="horizontal"
					>
						<BaseScrollArea.Thumb className="h-full rounded bg-foreground-muted/40" />
					</BaseScrollArea.Scrollbar>
					<BaseScrollArea.Corner />
				</>
			)}
		</BaseScrollArea.Root>
	);
}
