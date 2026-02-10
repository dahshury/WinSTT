"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export interface ButtonProps {
	children?: ReactNode;
	disabled?: boolean;
	onClick?: (event: React.MouseEvent) => void;
	type?: "button" | "submit" | "reset";
	className?: string;
	title?: string;
	"aria-label"?: string;
}

export function Button({
	children,
	disabled,
	onClick,
	type = "button",
	className,
	title,
	"aria-label": ariaLabel,
}: ButtonProps) {
	return (
		<BaseButton
			aria-label={ariaLabel}
			className={cn(
				"inline-flex cursor-pointer items-center justify-center border-none font-sans outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-default disabled:opacity-40",
				className
			)}
			disabled={disabled}
			onClick={onClick}
			title={title}
			type={type}
		>
			{children}
		</BaseButton>
	);
}
