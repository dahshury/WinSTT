"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

export interface SpinnerProps extends ComponentPropsWithoutRef<"span"> {
	/** Optional explicit size; defaults to inherited via className */
}

export function Spinner({ className, ...rest }: SpinnerProps) {
	return (
		<span
			aria-busy="true"
			aria-live="polite"
			className={cn(
				"inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent",
				className
			)}
			role="status"
			{...rest}
		/>
	);
}
