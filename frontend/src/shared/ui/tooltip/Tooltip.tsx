import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { SurfaceProvider, surfaceClasses, useSurface } from "@/shared/lib/surface";

export interface TooltipProps {
	/** The trigger element — must accept forwarded props via cloneElement */
	children: ReactElement;
	/** The tooltip text */
	content: string;
	/**
	 * Open delay in ms. When set, wraps the tooltip in a nested Tooltip.Provider
	 * so this single tooltip uses a different delay than the app-wide default.
	 */
	delay?: number;
	/** Which side to show the tooltip on */
	side?: "top" | "bottom" | "left" | "right";
	/** Offset from the trigger in px */
	sideOffset?: number;
}

function TooltipBody({
	content,
	children,
	side,
	sideOffset,
}: Required<Pick<TooltipProps, "content" | "children" | "sideOffset">> & {
	side?: TooltipProps["side"];
}) {
	const substrate = useSurface();
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger
				render={cloneElement(children, { suppressHydrationWarning: true } as Record<
					string,
					unknown
				>)}
			/>
			<TooltipPrimitive.Portal>
				<SurfaceProvider value={popupLevel}>
					<TooltipPrimitive.Positioner
						side={side}
						sideOffset={sideOffset}
						style={{ zIndex: Z_INDEX.tooltip }}
					>
						<TooltipPrimitive.Popup
							className={`max-w-[260px] origin-(--transform-origin) rounded-md ${surfaceClasses(popupLevel, popupShadow)} px-2.5 py-1.5 font-sans text-[11.5px] text-foreground-secondary leading-[16px] transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[instant]:transition-none`}
						>
							{content}
						</TooltipPrimitive.Popup>
					</TooltipPrimitive.Positioner>
				</SurfaceProvider>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

export function Tooltip({ content, children, side, sideOffset = 6, delay }: TooltipProps) {
	const body: ReactNode = (
		<TooltipBody content={content} side={side} sideOffset={sideOffset}>
			{children}
		</TooltipBody>
	);
	if (delay !== undefined) {
		return (
			<TooltipPrimitive.Provider closeDelay={0} delay={delay}>
				{body}
			</TooltipPrimitive.Provider>
		);
	}
	return body;
}
