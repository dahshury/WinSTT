/** shadcn-compatible `Badge` styled with WinSTT surface tokens. */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { Slot } from "./slot";

const badgeVariants = cva(
	"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium text-2xs leading-none [&_svg]:size-3 [&_svg]:pointer-events-none",
	{
		variants: {
			variant: {
				default: "border-transparent bg-accent text-foreground",
				secondary: "border-transparent bg-surface-5 text-foreground",
				destructive: "border-transparent bg-error text-foreground",
				outline: "border-border bg-transparent text-foreground-secondary",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

export interface BadgeProps
	extends ComponentPropsWithoutRef<"span">, VariantProps<typeof badgeVariants> {
	asChild?: boolean;
}

export function Badge({
	asChild = false,
	className,
	variant,
	...props
}: BadgeProps) {
	const classes = cn(badgeVariants({ variant }), className);
	if (asChild) {
		return <Slot.Slot className={classes} {...props} />;
	}
	return <span className={classes} {...props} />;
}
