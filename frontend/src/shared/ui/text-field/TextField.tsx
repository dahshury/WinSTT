"use client";

import { Input } from "@base-ui/react/input";
import type { ComponentPropsWithoutRef, Ref } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";

export interface TextFieldProps extends ComponentPropsWithoutRef<"input"> {
	error?: boolean;
	ref?: Ref<HTMLInputElement>;
}

export function TextField({ className, error, ref, ...props }: TextFieldProps) {
	const substrate = useSurface();
	const inputLevel = Math.min(substrate + 1, 8);
	return (
		<Input
			className={cn(
				"h-8 w-full rounded-sm px-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				surfaceClasses(inputLevel),
				error && "border-error focus:border-error",
				className
			)}
			ref={ref}
			{...props}
		/>
	);
}
