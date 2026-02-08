"use client";

import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

export interface IconButtonProps {
	icon: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	title?: string;
	className?: string;
}

export function IconButton({ icon, onClick, disabled, title, className }: IconButtonProps) {
	return (
		<Button
			className={cn(
				"size-7 rounded-full bg-transparent p-0 text-foreground-muted hover:bg-surface-hover hover:text-foreground-secondary",
				className
			)}
			disabled={disabled}
			onClick={onClick}
			title={title}
		>
			{icon}
		</Button>
	);
}
