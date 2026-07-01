/** shadcn-compatible Tooltip on base-ui, styled with WinSTT surface tokens. */
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export function Tooltip({
	children,
	delayDuration,
}: {
	children?: ReactNode;
	delayDuration?: number;
}) {
	return (
		<TooltipPrimitive.Provider delay={delayDuration ?? 200}>
			<TooltipPrimitive.Root>{children}</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}

// eslint-disable-next-line react-doctor/no-multi-comp -- compound component: Tooltip/Trigger/Content are one cohesive shadcn primitive and belong in one file
export function TooltipTrigger({
	asChild,
	children,
	...props
}: {
	asChild?: boolean;
	children?: ReactNode;
} & ComponentPropsWithoutRef<"button">) {
	if (asChild) {
		return <TooltipPrimitive.Trigger render={children as ReactElement} />;
	}
	return (
		<TooltipPrimitive.Trigger {...props}>{children}</TooltipPrimitive.Trigger>
	);
}

export interface TooltipContentProps {
	children?: ReactNode;
	className?: string;
	side?: "top" | "bottom" | "left" | "right";
	sideOffset?: number;
}

// eslint-disable-next-line react-doctor/no-multi-comp -- compound component: one cohesive shadcn Tooltip primitive
export function TooltipContent({
	children,
	className,
	side,
	sideOffset = 6,
}: TooltipContentProps) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Positioner
				className="z-tooltip outline-none"
				side={side}
				sideOffset={sideOffset}
			>
				<TooltipPrimitive.Popup
					className={cn(
						"max-w-[260px] whitespace-pre-line rounded-md border border-border bg-surface-6 px-2.5 py-1.5 font-sans text-[11.5px] text-foreground-secondary leading-[16px] shadow-overlay",
						className,
					)}
				>
					{children}
				</TooltipPrimitive.Popup>
			</TooltipPrimitive.Positioner>
		</TooltipPrimitive.Portal>
	);
}
