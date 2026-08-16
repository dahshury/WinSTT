import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { cn } from "@/shared/lib/cn";

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
	children?: ReactNode;
	/** Handle on the rendered element, for callers that must drive focus (e.g.
	 *  returning focus to the control that opened an inline editor). Typed
	 *  `HTMLElement` rather than `HTMLButtonElement` because that is Base UI's own
	 *  ref contract for every rendered element, and `RefObject` is invariant. */
	ref?: Ref<HTMLElement>;
}

export function Button({
	children,
	type = "button",
	className,
	...rest
}: ButtonProps) {
	return (
		<BaseButton
			className={cn(
				"inline-flex cursor-pointer touch-manipulation select-none items-center justify-center border-none font-sans outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-default disabled:opacity-40",
				className,
			)}
			type={type}
			{...rest}
		>
			{children}
		</BaseButton>
	);
}
