"use client";

import type { Ref } from "react";
import { cn } from "@/shared/lib/cn";

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
	error?: boolean;
	ref?: Ref<HTMLInputElement>;
}

export function TextField({ className, error, ref, ...props }: TextFieldProps) {
	return (
		<input
			className={cn(
				"h-8 w-full rounded-sm border border-border bg-surface-tertiary px-2.5 text-[13px] text-foreground caret-accent outline-none placeholder:text-foreground-muted focus:border-border-hover",
				error && "border-error focus:border-error",
				className
			)}
			ref={ref}
			{...props}
		/>
	);
}
