"use client";

import { Input } from "@base-ui/react/input";
import type { ComponentPropsWithoutRef, Ref } from "react";
import { cn } from "@/shared/lib/cn";

export interface TextFieldProps extends ComponentPropsWithoutRef<"input"> {
	error?: boolean;
	ref?: Ref<HTMLInputElement>;
}

export function TextField({ className, error, ref, ...props }: TextFieldProps) {
	return (
		<Input
			className={cn(
				"h-8 w-full rounded-sm border border-border bg-surface-tertiary px-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
				error && "border-error focus:border-error",
				className
			)}
			ref={ref}
			{...props}
		/>
	);
}
