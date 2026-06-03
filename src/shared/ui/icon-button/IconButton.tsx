import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

export interface IconButtonProps {
	/** Accessible label — required for icon-only buttons (WCAG 4.1.2) */
	"aria-label": string;
	className?: string | undefined;
	disabled?: boolean | undefined;
	icon: ReactNode;
	onClick?: (() => void) | undefined;
	/** Tooltip text — defaults to aria-label */
	tooltip?: string | undefined;
}

export function IconButton({
	icon,
	onClick,
	disabled,
	"aria-label": ariaLabel,
	tooltip,
	className,
}: IconButtonProps) {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const button = (
		<Button
			aria-label={ariaLabel}
			className={cn(
				"size-7 rounded-full bg-transparent p-0 text-foreground-muted hover:text-foreground-secondary",
				surfaceHoverBg(hoverLevel),
				className
			)}
			disabled={disabled}
			onClick={onClick}
		>
			{icon}
		</Button>
	);
	// A natively-`disabled` <button> fires no pointer/focus events, so the
	// Tooltip trigger (which clones the single child) never receives hover —
	// the tooltip silently never shows (Base UI #9). Wrap the disabled button
	// in a focusable, hover-capable <span> so the trigger still gets events;
	// the inner button keeps `disabled` (no click, correct semantics).
	return (
		<Tooltip content={tooltip ?? ariaLabel}>
			{disabled ? (
				<span className="inline-flex" tabIndex={0}>
					{button}
				</span>
			) : (
				button
			)}
		</Tooltip>
	);
}
