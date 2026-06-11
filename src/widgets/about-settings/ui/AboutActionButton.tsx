import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";

type AboutActionButtonVariant = "neutral" | "accent" | "danger";

interface AboutActionButtonProps {
	children: ReactNode;
	disabled?: boolean;
	icon: IconSvgElement;
	iconClassName?: string | undefined;
	onClick: () => void;
	variant?: AboutActionButtonVariant;
}

const VARIANT_CLASS: Record<AboutActionButtonVariant, string> = {
	neutral: "text-foreground",
	accent: "font-medium text-accent",
	danger: "font-medium text-error hover:bg-error-dim/40",
};

function AboutActionButtonTrigger({
	children,
	disabled,
	icon,
	iconClassName,
	onClick,
	variant = "neutral",
}: AboutActionButtonProps) {
	const substrate = useSurface();
	const level = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(substrate + 2, 8);

	return (
		<Button
			className={cn(
				"flex h-8 w-full items-center justify-start gap-2 rounded-lg px-2.5 text-body leading-normal transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
				surfaceClasses(level),
				variant === "danger" ? undefined : surfaceHoverBg(hoverLevel),
				VARIANT_CLASS[variant],
			)}
			disabled={disabled}
			onClick={onClick}
		>
			<HugeiconsIcon
				aria-hidden="true"
				className={cn(
					"shrink-0",
					variant === "neutral" ? "text-foreground-muted" : "text-current",
					iconClassName,
				)}
				icon={icon}
				size={14}
			/>
			<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
				{children}
			</span>
		</Button>
	);
}

export function AboutActionButton(props: AboutActionButtonProps) {
	return (
		<ElevatedSurface className="w-52 shrink-0" inline>
			<AboutActionButtonTrigger {...props} />
		</ElevatedSurface>
	);
}
