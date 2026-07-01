/** shadcn-compatible `Kbd` / `KbdGroup` styled with WinSTT surface tokens. */
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

export function Kbd({ className, ...props }: ComponentPropsWithoutRef<"kbd">) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 select-none items-center justify-center rounded border border-border bg-surface-4 px-1.5 font-mono font-medium text-[10px] text-foreground-secondary",
				className,
			)}
			{...props}
		/>
	);
}

export function KbdGroup({
	className,
	...props
}: ComponentPropsWithoutRef<"span">) {
	return (
		<span
			className={cn("inline-flex items-center gap-1", className)}
			{...props}
		/>
	);
}
