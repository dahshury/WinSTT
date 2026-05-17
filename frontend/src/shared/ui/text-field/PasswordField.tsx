"use client";

import { Input } from "@base-ui/react/input";
import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, type Ref, useState } from "react";
import { cn } from "@/shared/lib/cn";

export interface PasswordFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
	error?: boolean;
	hideLabel?: string;
	ref?: Ref<HTMLInputElement>;
	revealLabel?: string;
}

export function PasswordField({
	className,
	error,
	hideLabel = "Hide",
	ref,
	revealLabel = "Show",
	...props
}: PasswordFieldProps) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="relative w-full">
			<Input
				className={cn(
					"h-8 w-full rounded-sm border border-border bg-surface-tertiary pr-9 pl-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
					error && "border-error focus:border-error",
					className
				)}
				ref={ref}
				type={revealed ? "text" : "password"}
				{...props}
			/>
			<button
				aria-label={revealed ? hideLabel : revealLabel}
				aria-pressed={revealed}
				className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-sm text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onClick={() => setRevealed((v) => !v)}
				type="button"
			>
				<HugeiconsIcon icon={revealed ? ViewOffIcon : ViewIcon} size={14} />
			</button>
		</div>
	);
}
