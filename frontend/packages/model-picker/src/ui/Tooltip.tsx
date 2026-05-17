"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";

/**
 * Internal Tooltip wrappers used across the OpenRouter model selector widget.
 *
 * The shared `@/shared/ui/tooltip` is content-prop-only (string content); the
 * ported event_manager components pass rich JSX, so we re-export Base UI's
 * primitives here in a shadcn-compatible shape.
 */

type TriggerProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>;

export interface TooltipProps {
	children: ReactNode;
	/**
	 * Open delay in ms. Honored only when a parent `<TooltipPrimitive.Provider>`
	 * is in scope; Base UI sets the per-tooltip delay there in 1.4. Accepted
	 * here for API parity with the ported components — silently ignored
	 * otherwise.
	 */
	delay?: number;
	/** When true, the tooltip never opens. */
	disabled?: boolean;
}

export function Tooltip({ children, disabled }: TooltipProps) {
	return <TooltipPrimitive.Root disabled={disabled}>{children}</TooltipPrimitive.Root>;
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
