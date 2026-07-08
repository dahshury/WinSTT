import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { useEffect, useRef, useState } from "react";
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
	/**
	 * When `false`, the scrollbar reveals ONLY while actively scrolling (or
	 * dragging the thumb) — hovering the content no longer surfaces it. Base UI
	 * flags `data-hovering` for the whole scroll-area root, so the default
	 * hover-reveal makes the bar look permanently present in a region the pointer
	 * always sits inside (e.g. a settings window). Defaults to `true`.
	 */
	revealScrollbarOnHover?: boolean;
	/** Class applied to the inner viewport (the scrollable region). */
	viewportClassName?: string;
	/** Ref to the inner viewport — use for programmatic scrolling. */
	viewportRef?: Ref<HTMLDivElement>;
	/** Inline style applied to the inner viewport. */
	viewportStyle?: CSSProperties;
}

// Fluid Functionalism-style overlay thumb: a comfortable 10px target with a
// quiet 4px resting thumb that widens and darkens on hover. Base UI keeps the
// scrollbar mounted while scrollable and supplies data-hovering/data-scrolling.
const VERTICAL_SCROLLBAR_CLASS =
	"group/scrollbar absolute top-0 end-0 z-overlay flex h-full w-2.5 touch-none select-none opacity-0 transition-opacity delay-[160ms] duration-[120ms] ease-out data-[scrolling]:opacity-100 data-[scrolling]:delay-0 data-[scrolling]:duration-[160ms]";
const HORIZONTAL_SCROLLBAR_CLASS =
	"group/scrollbar absolute bottom-0 start-0 z-overlay flex h-2.5 w-full touch-none select-none flex-col opacity-0 transition-opacity delay-[160ms] duration-[120ms] ease-out data-[scrolling]:opacity-100 data-[scrolling]:delay-0 data-[scrolling]:duration-[160ms]";
// Hover-reveal fragment, merged onto the base scrollbar class unless the caller
// opts out via `revealScrollbarOnHover={false}` (scroll-only reveal).
const SCROLLBAR_HOVER_REVEAL_CLASS =
	"data-[hovering]:opacity-100 data-[hovering]:delay-0 data-[hovering]:duration-[160ms]";
const VERTICAL_THUMB_CLASS =
	"relative mx-auto my-1 h-[var(--scroll-area-thumb-height)] w-1 rounded-full bg-foreground-muted/35 transition-[background-color,width] duration-[160ms] ease-in-out group-hover/scrollbar:w-1.5 group-hover/scrollbar:bg-foreground-muted/55 active:!bg-foreground-secondary/70";
const HORIZONTAL_THUMB_CLASS =
	"relative mx-1 my-auto h-1 w-[var(--scroll-area-thumb-width)] rounded-full bg-foreground-muted/35 transition-[background-color,height] duration-[160ms] ease-in-out group-hover/scrollbar:h-1.5 group-hover/scrollbar:bg-foreground-muted/55 active:!bg-foreground-secondary/70";

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

function hasTouchPrimaryPointer() {
	if (typeof window === "undefined") {
		return false;
	}
	if (window.matchMedia) {
		return window.matchMedia("(pointer: coarse)").matches;
	}
	return navigator.maxTouchPoints > 0;
}

function useTouchPrimary() {
	const [isTouchPrimary, setIsTouchPrimary] = useState(hasTouchPrimaryPointer);

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) {
			return;
		}
		const pointerQuery = window.matchMedia("(pointer: coarse)");
		const finePointerQuery = window.matchMedia("(any-pointer: fine)");
		const update = () => setIsTouchPrimary(hasTouchPrimaryPointer());
		pointerQuery.addEventListener("change", update);
		finePointerQuery.addEventListener("change", update);
		update();
		return () => {
			pointerQuery.removeEventListener("change", update);
			finePointerQuery.removeEventListener("change", update);
		};
	}, []);

	return isTouchPrimary;
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
		if (!(viewport && content)) {
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
		viewport.addEventListener("touchmove", onTouchMove, { passive: true });
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
	revealScrollbarOnHover = true,
	viewportClassName,
	viewportStyle,
	viewportRef,
	verticalScrollbarClassName,
	verticalOnly = false,
	...rest
}: ScrollAreaProps) {
	const localViewportRef = useRef<HTMLDivElement>(null);
	const rubberBandContentRef = useRef<HTMLDivElement>(null);
	const isTouchPrimary = useTouchPrimary();
	useTouchRubberBand(
		rubberBandOnTouch && !isTouchPrimary,
		localViewportRef,
		rubberBandContentRef,
	);
	const resolvedViewportStyle = {
		...(verticalOnly ? { overflowX: "hidden" as const } : null),
		...(rubberBandOnTouch ? { overscrollBehaviorY: "contain" as const } : null),
		...viewportStyle,
	};

	if (isTouchPrimary) {
		const touchViewportStyle = {
			...(verticalOnly ? { overflowX: "hidden" as const } : null),
			...viewportStyle,
		};

		return (
			<div
				aria-roledescription="scroll area"
				className={cn("relative overflow-hidden", className)}
				data-slot="scroll-area"
				role="group"
				{...rest}
			>
				<div
					className={cn(
						"h-full w-full rounded-[inherit]",
						verticalOnly ? "overflow-y-auto" : "overflow-auto",
						viewportClassName,
					)}
					data-rubber-band={rubberBandOnTouch ? undefined : "off"}
					data-slot="scroll-area-viewport"
					ref={(node) => {
						localViewportRef.current = node;
						assignRef(viewportRef, node);
					}}
					style={touchViewportStyle}
				>
					{children}
				</div>
			</div>
		);
	}

	return (
		<BaseScrollArea.Root
			className={cn("relative overflow-hidden", className)}
			data-slot="scroll-area"
			{...rest}
		>
			<BaseScrollArea.Viewport
				className={cn(
					"h-full w-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
					viewportClassName,
				)}
				data-rubber-band={rubberBandOnTouch ? undefined : "off"}
				data-rubber-band-managed={rubberBandOnTouch ? "local" : undefined}
				data-slot="scroll-area-viewport"
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
				className={cn(
					VERTICAL_SCROLLBAR_CLASS,
					revealScrollbarOnHover && SCROLLBAR_HOVER_REVEAL_CLASS,
					verticalScrollbarClassName,
				)}
				data-slot="scroll-area-scrollbar"
				orientation="vertical"
			>
				<BaseScrollArea.Thumb
					className={VERTICAL_THUMB_CLASS}
					data-slot="scroll-area-thumb"
				/>
			</BaseScrollArea.Scrollbar>
			{verticalOnly ? null : (
				<>
					<BaseScrollArea.Scrollbar
						className={cn(
							HORIZONTAL_SCROLLBAR_CLASS,
							revealScrollbarOnHover && SCROLLBAR_HOVER_REVEAL_CLASS,
						)}
						data-slot="scroll-area-scrollbar"
						orientation="horizontal"
					>
						<BaseScrollArea.Thumb
							className={HORIZONTAL_THUMB_CLASS}
							data-slot="scroll-area-thumb"
						/>
					</BaseScrollArea.Scrollbar>
					<BaseScrollArea.Corner />
				</>
			)}
		</BaseScrollArea.Root>
	);
}
