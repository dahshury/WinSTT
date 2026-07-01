/** shadcn-compatible `Textarea` styled with WinSTT surface tokens. */
import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/cn";

export type TextareaProps = ComponentProps<"textarea">;

export function Textarea({ className, ref, ...props }: TextareaProps) {
	return (
		<textarea
			className={cn(
				"flex min-h-[64px] w-full rounded-md border border-border bg-surface-3 px-2.5 py-1.5 text-body text-foreground outline-none transition-colors placeholder:text-foreground-muted focus-visible:border-border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			ref={ref}
			{...props}
		/>
	);
}
