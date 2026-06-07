import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";

type BadgeVariant = "default" | "secondary" | "outline";

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
	children?: ReactNode;
	variant?: BadgeVariant;
}

export function Badge({
	children,
	variant = "default",
	className,
	...rest
}: BadgeProps) {
	// `secondary` is a neutral chip — lift it one step above whatever surface it
	// sits on (surfaces system) instead of a flat token, so it stays distinct
	// inside elevated panels/cards. `default`/`outline` carry their own intent.
	const secondaryBg = surfaceBg(Math.min(useSurface() + 1, 8));
	const variantClass: Record<BadgeVariant, string> = {
		default: "border-transparent bg-accent text-foreground",
		secondary: cn("border-transparent text-foreground", secondaryBg),
		outline: "border-border bg-transparent text-foreground-secondary",
	};
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium text-2xs leading-none",
				variantClass[variant],
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
}
