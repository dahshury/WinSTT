"use client";

import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { cn } from "@/shared/lib/cn";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<"div"> {
	children: ReactNode;
	/** Class applied to the inner viewport (the scrollable region). */
	viewportClassName?: string;
	/** Ref to the inner viewport — use for programmatic scrolling. */
	viewportRef?: Ref<HTMLDivElement>;
	/** Inline style applied to the inner viewport. */
	viewportStyle?: React.CSSProperties;
}

export function ScrollArea({
	children,
	className,
	viewportClassName,
	viewportStyle,
	viewportRef,
	...rest
}: ScrollAreaProps) {
	return (
		<BaseScrollArea.Root className={cn("relative overflow-hidden", className)} {...rest}>
			<BaseScrollArea.Viewport
				className={cn("h-full w-full", viewportClassName)}
				ref={viewportRef}
				style={viewportStyle}
			>
				{children}
			</BaseScrollArea.Viewport>
			<BaseScrollArea.Scrollbar
				className="m-0.5 flex w-1.5 justify-center rounded bg-transparent opacity-0 transition-opacity delay-150 duration-150 data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[hovering]:delay-0 data-[scrolling]:delay-0"
				orientation="vertical"
			>
				<BaseScrollArea.Thumb className="w-full rounded bg-foreground-muted/40" />
			</BaseScrollArea.Scrollbar>
			<BaseScrollArea.Scrollbar
				className="m-0.5 flex h-1.5 items-center rounded bg-transparent opacity-0 transition-opacity delay-150 duration-150 data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[hovering]:delay-0 data-[scrolling]:delay-0"
				orientation="horizontal"
			>
				<BaseScrollArea.Thumb className="h-full rounded bg-foreground-muted/40" />
			</BaseScrollArea.Scrollbar>
			<BaseScrollArea.Corner />
		</BaseScrollArea.Root>
	);
}
