import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
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
	viewportStyle?: React.CSSProperties;
}

// Auto-hiding overlay thumb: invisible at rest, fades in ONLY while actively
// scrolling (not on hover). Per-side margins (not the `m-*` shorthand) so a
// caller can override a single side through `verticalScrollbarClassName` without
// a shorthand-vs-longhand specificity clash in tailwind-merge.
const VERTICAL_SCROLLBAR_CLASS =
	"mt-0.5 mb-0.5 me-0.5 flex w-1.5 justify-center rounded bg-transparent opacity-0 transition-opacity delay-150 duration-150 data-[scrolling]:opacity-100 data-[scrolling]:delay-0";

export function ScrollArea({
	children,
	className,
	viewportClassName,
	viewportStyle,
	viewportRef,
	verticalScrollbarClassName,
	verticalOnly = false,
	...rest
}: ScrollAreaProps) {
	return (
		<BaseScrollArea.Root className={cn("relative overflow-hidden", className)} {...rest}>
			<BaseScrollArea.Viewport
				className={cn("h-full w-full", viewportClassName)}
				ref={viewportRef}
				style={verticalOnly ? { overflowX: "hidden", ...viewportStyle } : viewportStyle}
			>
				{children}
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
