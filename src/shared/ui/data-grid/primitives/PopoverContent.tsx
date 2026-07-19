import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { use } from "react";
import { cn } from "@/shared/lib/cn";
import { AnchorContext } from "./popover-context";
import type { PopoverContentProps } from "./popover.types";

export function PopoverContent({
	align = "center",
	alignOffset,
	children,
	className,
	onCloseAutoFocus,
	onEscapeKeyDown,
	onInteractOutside,
	onOpenAutoFocus,
	side = "bottom",
	sideOffset = 4,
	...props
}: PopoverContentProps) {
	const ctx = use(AnchorContext);
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={ctx?.hasAnchor ? ctx.anchorRef : undefined}
				className="z-popover outline-none"
				collisionPadding={8}
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(
						"origin-[var(--transform-origin)] rounded-lg border border-border bg-surface-5 p-2 text-foreground shadow-overlay outline-none",
						className,
					)}
					finalFocus={
						onCloseAutoFocus
							? () => {
									onCloseAutoFocus(new Event("close"));
									return false;
								}
							: undefined
					}
					initialFocus={onOpenAutoFocus ? false : undefined}
					{...props}
				>
					{children}
				</PopoverPrimitive.Popup>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}
