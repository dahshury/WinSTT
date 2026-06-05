import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
	children?: ReactNode;
}

export function Button({ children, type = "button", className, ...rest }: ButtonProps) {
	return (
		<BaseButton
			className={cn(
				"inline-flex cursor-pointer touch-manipulation select-none items-center justify-center border-none font-sans outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-default disabled:opacity-40",
				className
			)}
			type={type}
			{...rest}
		>
			{children}
		</BaseButton>
	);
}
