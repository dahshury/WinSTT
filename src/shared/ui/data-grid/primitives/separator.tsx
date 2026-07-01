/** shadcn-compatible `Separator` styled with WinSTT divider tokens. */
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

export interface SeparatorProps extends ComponentPropsWithoutRef<"div"> {
	orientation?: "horizontal" | "vertical";
	decorative?: boolean;
}

export function Separator({
	className,
	decorative = true,
	orientation = "horizontal",
	...props
}: SeparatorProps) {
	return (
		<div
			aria-orientation={decorative ? undefined : orientation}
			className={cn(
				"shrink-0 bg-divider",
				orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
				className,
			)}
			data-orientation={orientation}
			role={decorative ? "none" : "separator"}
			{...props}
		/>
	);
}
