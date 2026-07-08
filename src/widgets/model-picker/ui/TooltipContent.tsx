"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";

export type TooltipContentProps = ComponentPropsWithoutRef<
	typeof TooltipPrimitive.Popup
> & {
	side?: "top" | "bottom" | "left" | "right";
	sideOffset?: number;
};

/** Tooltips are pinned to one fixed surface app-wide (see
 *  src/shared/ui/tooltip/Tooltip.tsx) so the same tooltip never renders
 *  lighter or darker depending on its substrate. */
const POPUP_LEVEL = 7;

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
			<SurfaceProvider value={POPUP_LEVEL}>
				<TooltipPrimitive.Positioner
					side={side}
					sideOffset={sideOffset}
					style={{ zIndex: Z_INDEX.tooltip, ...style }}
				>
					<TooltipPrimitive.Popup
						className={cn(
							"max-w-[260px] origin-(--transform-origin) rounded-lg px-3 py-2 font-sans text-[11.5px] text-foreground leading-[16px] transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none",
							surfaceClasses(POPUP_LEVEL),
							className,
						)}
						{...rest}
					>
						{children}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</SurfaceProvider>
		</TooltipPrimitive.Portal>
	);
}
