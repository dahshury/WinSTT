"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

export interface ActiveFilterBadgeProps {
	className?: string;
	label: string;
	onRemove: () => void;
	value: string;
}

/**
 * Two distinct buttons in a segmented group — clicking the value shows a
 * tooltip describing the filter, clicking × removes it.
 */
export function ActiveFilterBadge({ label, value, onRemove, className }: ActiveFilterBadgeProps) {
	return (
		<div
			className={cn(
				"inline-flex items-stretch overflow-hidden rounded-md bg-foreground/[0.04] text-foreground-muted text-xs-tight",
				className
			)}
			data-slot="active-filter-badge"
		>
			<Tooltip>
				<TooltipTrigger
					render={(triggerProps) => (
						<button
							{...(triggerProps as ComponentPropsWithoutRef<"button">)}
							aria-label={`${label}: ${value}`}
							className="flex h-6 items-center gap-1 px-2 font-medium transition-colors hover:bg-foreground/[0.08] hover:text-foreground-secondary"
							type="button"
						>
							<span>{value}</span>
						</button>
					)}
				/>
				<TooltipContent>{`${label}: ${value}`}</TooltipContent>
			</Tooltip>
			<button
				aria-label={`Remove filter: ${label} ${value}`}
				className="flex h-6 items-center justify-center border-foreground/[0.06] border-s px-1.5 text-foreground-dim transition-colors hover:bg-error/15 hover:text-error"
				onClick={onRemove}
				type="button"
			>
				<span aria-hidden="true">×</span>
			</button>
		</div>
	);
}
