"use client";

import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { REASONING_EFFORT_OPTIONS, type ReasoningEffort } from "../config/model-selector-options";

export interface ReasoningEffortDropdownProps {
	className?: string;
	disabled: boolean;
	onChange: (value: ReasoningEffort) => void;
	value: ReasoningEffort;
}

/**
 * Three-segment radio toggle (Low / Medium / High) bound to the reasoning
 * effort axis. Rendered as a `role="radiogroup"` for screen-reader parity
 * with the surrounding settings UI.
 */
export function ReasoningEffortDropdown({
	className,
	disabled,
	onChange,
	value,
}: ReasoningEffortDropdownProps) {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<div
			aria-label="Reasoning effort"
			className={cn(
				"flex w-full min-w-0 max-w-full gap-1 rounded-md border border-border bg-surface-secondary/60 p-1 shadow-inner",
				disabled && "cursor-not-allowed opacity-60",
				className
			)}
			data-slot="reasoning-effort-dropdown"
			role="radiogroup"
		>
			{REASONING_EFFORT_OPTIONS.map((option) => {
				const isSelected = value === option.value;
				return (
					// biome-ignore lint/a11y/useSemanticElements: radiogroup-of-buttons pattern; parent has role="radiogroup", a native input breaks the styled segmented control
					<button
						aria-checked={isSelected}
						className={cn(
							"relative flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center truncate rounded-sm px-2 text-sm transition-[background-color,color,box-shadow] duration-200",
							isSelected
								? cn("font-semibold text-foreground shadow-md ring-1 ring-border", surfaceBg(level))
								: "bg-transparent font-medium text-foreground-muted hover:bg-surface/60 hover:text-foreground",
							disabled && "pointer-events-none"
						)}
						data-slot="reasoning-effort-option"
						data-state={isSelected ? "selected" : "idle"}
						disabled={disabled}
						key={option.value}
						onClick={() => onChange(option.value)}
						role="radio"
						tabIndex={isSelected ? 0 : -1}
						type="button"
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
