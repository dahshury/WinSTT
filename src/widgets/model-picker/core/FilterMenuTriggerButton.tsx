"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { FilterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

export interface FilterMenuTriggerButtonProps {
	buttonProps: ComponentPropsWithoutRef<"button">;
	className?: string | undefined;
	count: number;
	icon?: IconSvgElement | undefined;
	label: string;
}

function activeFilterTriggerLabel(label: string, count: number): string {
	return count > 0 ? `${label} (${count} active)` : label;
}

function displayCount(count: number): string {
	return count > 99 ? "99+" : String(count);
}

/**
 * Shared count-badged trigger for every model-picker filter/sort control.
 * The state and popup shape stay provider-specific; the affordance does not.
 */
export function FilterMenuTriggerButton({
	buttonProps,
	className,
	count,
	icon = FilterIcon,
	label,
}: FilterMenuTriggerButtonProps) {
	const isActive = count > 0;
	const triggerLabel = activeFilterTriggerLabel(label, count);
	return (
		<BaseButton
			{...buttonProps}
			aria-label={triggerLabel}
			className={cn(
				"relative inline-flex size-7 items-center justify-center rounded-sm border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
				isActive
					? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
					: "border-transparent bg-transparent text-foreground-secondary hover:bg-surface-hover",
				className,
			)}
			data-active-filters={count > 0 ? count : undefined}
			title={triggerLabel}
			type="button"
		>
			<HugeiconsIcon aria-hidden="true" className="size-4" icon={icon} />
			{count > 0 ? (
				<span
					className={cn(
						"absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full",
						"border border-divider bg-accent px-1 font-semibold text-[9px] text-white tabular-nums leading-none",
					)}
				>
					{displayCount(count)}
				</span>
			) : null}
		</BaseButton>
	);
}
