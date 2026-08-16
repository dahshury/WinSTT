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

/** Width of the trailing action column of an About row. Exported so a row that
 *  carries no action can reserve the same column and keep the list aligned. */
export const ABOUT_ACTION_WIDTH = "w-52";

interface AboutActionButtonProps {
	/** Accessible name override. Needed where the visible label repeats down a
	 *  list ("Remove") and the name must say WHAT is being acted on; it keeps
	 *  the visible label as its prefix so speech input still matches. */
	ariaLabel?: string | undefined;
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
	ariaLabel,
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
			aria-label={ariaLabel}
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
		<ElevatedSurface className={cn(ABOUT_ACTION_WIDTH, "shrink-0")} inline>
			<AboutActionButtonTrigger {...props} />
		</ElevatedSurface>
	);
}
