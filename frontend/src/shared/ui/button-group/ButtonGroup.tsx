import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface ButtonGroupProps {
	children: ReactNode;
	className?: string;
	"aria-label"?: string;
}

export function ButtonGroup({ children, className, "aria-label": ariaLabel }: ButtonGroupProps) {
	return (
		<div aria-label={ariaLabel} className={cn("inline-flex", className)} role="toolbar">
			{children}
		</div>
	);
}
