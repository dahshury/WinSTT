"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";
import { FilterMenuTriggerButton } from "../core/FilterMenuTriggerButton";

export function FilterMenuPopover({
	canClear,
	children,
	clearLabel,
	count,
	dataSlot,
	label,
	onClear,
	widthClass,
}: {
	canClear: boolean;
	children: ReactNode;
	clearLabel: string;
	count: number;
	dataSlot: string;
	label: string;
	onClear: () => void;
	widthClass: string;
}) {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<FilterMenuTriggerButton
						buttonProps={props as ComponentPropsWithoutRef<"button">}
						count={count}
						label={label}
					/>
				)}
			/>
			<Popover.Portal>
				<Popover.Positioner
					align="end"
					sideOffset={6}
					style={{ zIndex: Z_INDEX.popover }}
				>
					<Popover.Popup
						className={cn(
							"select-popup origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							widthClass,
							surfaceBg(level),
						)}
						data-slot={dataSlot}
					>
						<SurfaceProvider value={level}>
							<div className="flex items-center justify-between px-2 py-1.5">
								<span className="font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
									{label}
								</span>
								{canClear ? (
									<BaseButton
										className="text-[11px] text-foreground-secondary hover:text-foreground hover:underline"
										onClick={onClear}
										type="button"
									>
										{clearLabel}
									</BaseButton>
								) : null}
							</div>
							{children}
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
