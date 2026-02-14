import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface ButtonGroupTextProps {
	children: ReactNode;
	className?: string;
}

export function ButtonGroupText({ children, className }: ButtonGroupTextProps) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 bg-surface-secondary px-3 py-1.5 text-[12px] text-foreground-dim",
				"first:rounded-l last:rounded-r",
				"border-border border-r last:border-r-0",
				className
			)}
		>
			{children}
		</div>
	);
}
