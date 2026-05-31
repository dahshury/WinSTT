"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";

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
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	return (
		<TooltipPrimitive.Portal>
			<SurfaceProvider value={popupLevel}>
				<TooltipPrimitive.Positioner
					side={side}
					sideOffset={sideOffset}
					style={{ zIndex: Z_INDEX.tooltip, ...style }}
				>
					<TooltipPrimitive.Popup
						className={cn(
							"max-w-[260px] origin-(--transform-origin) rounded-md px-2.5 py-1.5 font-sans text-foreground-secondary text-xs-tight leading-[16px] transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none",
							surfaceClasses(popupLevel, popupShadow),
							className
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
