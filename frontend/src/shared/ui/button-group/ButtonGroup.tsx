import type { ReactNode } from "react";
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
}

export function ButtonGroup({
	children,
	className,
	connected = false,
	orientation = "horizontal",
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
				role="toolbar"
			>
				{children}
			</div>
		);
	}

	return (
		<div
			aria-label={ariaLabel}
			className={cn(
				"inline-flex overflow-hidden rounded-md ring-1 ring-divider [&>button]:rounded-none",
				surfaceBg(level),
				vertical ? "flex-col divide-y divide-divider" : "divide-x divide-divider",
				className
			)}
			role="toolbar"
		>
			{children}
		</div>
	);
}
