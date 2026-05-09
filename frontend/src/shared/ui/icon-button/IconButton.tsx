"use client";

import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

export interface IconButtonProps {
	/** Accessible label — required for icon-only buttons (WCAG 4.1.2) */
	"aria-label": string;
	className?: string;
	disabled?: boolean;
	icon: ReactNode;
	onClick?: () => void;
	/** Tooltip text — defaults to aria-label */
	tooltip?: string;
}

export function IconButton({
	icon,
	onClick,
	disabled,
	"aria-label": ariaLabel,
	tooltip,
	className,
}: IconButtonProps) {
	return (
		<Tooltip content={tooltip ?? ariaLabel}>
			<Button
				aria-label={ariaLabel}
				className={cn(
					"size-7 rounded-full bg-transparent p-0 text-foreground-muted hover:bg-surface-hover hover:text-foreground-secondary",
					className
				)}
				disabled={disabled}
				onClick={onClick}
			>
				{icon}
			</Button>
		</Tooltip>
	);
}
