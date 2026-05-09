"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Z_INDEX } from "@/shared/lib/z-index";

/**
 * Internal Tooltip wrappers used across the OpenRouter model selector widget.
 *
 * The shared `@/shared/ui/tooltip` is content-prop-only (string content); the
 * ported event_manager components pass rich JSX, so we re-export Base UI's
 * primitives here in a shadcn-compatible shape.
 */

type TriggerProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>;

export function Tooltip({ children }: { children: ReactNode }) {
	return <TooltipPrimitive.Root>{children}</TooltipPrimitive.Root>;
}

export function TooltipTrigger(props: TriggerProps) {
	return <TooltipPrimitive.Trigger {...props} />;
}

export type TooltipContentProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> & {
	side?: "top" | "bottom" | "left" | "right";
	sideOffset?: number;
};

export function TooltipContent({
	className,
	children,
	side = "top",
	sideOffset = 6,
	style,
	...rest
}: TooltipContentProps) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				style={{ zIndex: Z_INDEX.tooltip, ...style }}
			>
				<TooltipPrimitive.Popup
					className={cn(
						"max-w-[260px] origin-(--transform-origin) rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 font-sans text-foreground-secondary text-xs-tight leading-[16px] shadow-md transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none",
						className
					)}
					{...rest}
				>
					{children}
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	);
}
