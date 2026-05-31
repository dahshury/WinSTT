import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

export interface IconButtonProps {
	/** Accessible label — required for icon-only buttons (WCAG 4.1.2) */
	"aria-label": string;
	className?: string | undefined;
	disabled?: boolean | undefined;
	icon: ReactNode;
	onClick?: (() => void) | undefined;
	/** Tooltip text — defaults to aria-label */
	tooltip?: string | undefined;
}

export function IconButton({
	icon,
	onClick,
	disabled,
	"aria-label": ariaLabel,
	tooltip,
	className,
}: IconButtonProps) {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	return (
		<Tooltip content={tooltip ?? ariaLabel}>
			<Button
				aria-label={ariaLabel}
				className={cn(
					"size-7 rounded-full bg-transparent p-0 text-foreground-muted hover:text-foreground-secondary",
					surfaceHoverBg(hoverLevel),
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
