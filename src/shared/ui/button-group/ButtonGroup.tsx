import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

export interface ButtonGroupProps {
	"aria-label"?: string;
	children: ReactNode;
	className?: string;
	/**
	 * Render as a visually-joined segment control: one lifted surface shared by
	 * all buttons, hairline dividers between them, and a single outer radius
	 * (inner button radii are flattened). Without this the group is just a bare
	 * `inline-flex` toolbar with whatever spacing the caller adds.
	 */
	connected?: boolean;
	/** Lay the segments out as a column. Default is a row. */
	orientation?: "horizontal" | "vertical";
	/** Override the default toolbar role when another container owns semantics. */
	role?: ComponentPropsWithoutRef<"div">["role"];
	/**
	 * Separator treatment for connected groups. `default` uses full-width
	 * dividers; `inset-strong` matches the denser history-row action groups.
	 */
	separator?: "default" | "inset-strong";
}

export function ButtonGroup({
	children,
	className,
	connected = false,
	orientation = "horizontal",
	role = "toolbar",
	separator = "default",
	"aria-label": ariaLabel,
}: ButtonGroupProps) {
	// Lift one step above the substrate so the joined control reads as its own
	// surface against whatever panel/card it sits on (surfaces system).
	const level = Math.min(useSurface() + 1, 8);
	const vertical = orientation === "vertical";

	if (!connected) {
		return (
			<div
				aria-label={ariaLabel}
				className={cn("inline-flex", vertical && "flex-col", className)}
				role={role}
			>
				{children}
			</div>
		);
	}

	const insetSeparator = vertical
		? cn(
				"divide-y-0 ring-divider-strong",
				"[&>button+button]:relative",
				"[&>button+button]:before:absolute",
				"[&>button+button]:before:inset-x-2",
				"[&>button+button]:before:top-0",
				"[&>button+button]:before:h-px",
				"[&>button+button]:before:bg-divider-strong",
				"[&>button+button]:before:content-['']",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:relative",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:absolute",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:inset-x-2",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:top-0",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:h-px",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:bg-divider-strong",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:content-['']",
			)
		: cn(
				"divide-x-0 ring-divider-strong",
				"[&>button+button]:relative",
				"[&>button+button]:before:absolute",
				"[&>button+button]:before:inset-y-2",
				"[&>button+button]:before:start-0",
				"[&>button+button]:before:w-px",
				"[&>button+button]:before:bg-divider-strong",
				"[&>button+button]:before:content-['']",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:relative",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:absolute",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:inset-y-2",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:start-0",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:w-px",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:bg-divider-strong",
				"[&>[data-button-group-item]+[data-button-group-item]_[data-button-group-segment]]:before:content-['']",
			);
	const separatorClasses =
		separator === "inset-strong"
			? insetSeparator
			: vertical
				? "divide-y divide-divider"
				: "divide-x divide-divider";

	return (
		<div
			aria-label={ariaLabel}
			className={cn(
				"inline-flex overflow-hidden rounded-md ring-1 ring-divider [&_button]:rounded-none [&_button]:border-0 [&_button]:shadow-none",
				surfaceBg(level),
				vertical && "flex-col",
				separatorClasses,
				className,
			)}
			role={role}
		>
			{children}
		</div>
	);
}
