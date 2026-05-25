import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

type BadgeVariant = "default" | "secondary" | "outline";

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
	children?: ReactNode;
	variant?: BadgeVariant;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
	default: "border-transparent bg-accent text-foreground",
	secondary: "border-transparent bg-surface-secondary text-foreground",
	outline: "border-border bg-transparent text-foreground-secondary",
};

export function Badge({ children, variant = "default", className, ...rest }: BadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium text-2xs leading-none",
				VARIANT_CLASSES[variant],
				className
			)}
			{...rest}
		>
			{children}
		</span>
	);
}
