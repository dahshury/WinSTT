/**
 * shadcn-compatible `Button` for the vendored DiceUI grid, styled with WinSTT
 * surface tokens. Native `<button>` (or `Slot` for `asChild`) — no Radix.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/cn";
import { Slot } from "./slot";

const buttonVariants = cva(
	"inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-accent text-foreground hover:bg-accent-hover",
				destructive: "bg-error text-foreground hover:bg-error/90",
				outline:
					"border border-border bg-transparent text-foreground-secondary hover:bg-surface-hover hover:text-foreground",
				secondary: "bg-surface-5 text-foreground hover:bg-surface-6",
				ghost:
					"bg-transparent text-foreground-secondary hover:bg-surface-hover hover:text-foreground",
				link: "bg-transparent text-accent underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 px-3 py-1.5",
				sm: "h-7 px-2.5 text-2xs",
				lg: "h-9 px-4",
				icon: "h-8 w-8 p-0",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export interface ButtonProps
	extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export function Button({
	asChild = false,
	className,
	ref,
	size,
	type,
	variant,
	...props
}: ButtonProps) {
	const classes = cn(buttonVariants({ size, variant }), className);
	if (asChild) {
		return <Slot.Slot className={classes} ref={ref} {...props} />;
	}
	return (
		<button className={classes} ref={ref} type={type ?? "button"} {...props} />
	);
}
