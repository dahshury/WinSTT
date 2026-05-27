import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";
import type { SwitcherOption } from "./Switcher";

interface SegmentRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

export interface SwitcherBadgeProps<T extends string> {
	option: SwitcherOption<T>;
	rect: SegmentRect;
}

export function SwitcherBadge<T extends string>({ option, rect }: SwitcherBadgeProps<T>) {
	const interactive = option.badgeTooltip !== undefined || option.onBadgeClick !== undefined;
	const badgeClass = cn(
		"absolute z-overlay inline-flex size-4 items-center justify-center rounded-full border bg-surface-elevated shadow-sm transition-colors duration-150",
		interactive
			? "cursor-pointer border-warning/40 text-warning/80 hover:border-warning hover:bg-warning/10 hover:text-warning"
			: "pointer-events-none border-border text-foreground-muted"
	);
	const badgeStyle = {
		top: rect.top - 6,
		left: rect.left + rect.width - 10,
	};
	const badgeIconRequired = option.badgeIcon;
	if (!badgeIconRequired) {
		return null;
	}
	const badgeIcon = (
		<HugeiconsIcon aria-hidden="true" className="shrink-0" icon={badgeIconRequired} size={10} />
	);
	if (!interactive) {
		return (
			<span aria-hidden="true" className={badgeClass} style={badgeStyle}>
				{badgeIcon}
			</span>
		);
	}
	const badgeButton = (
		<button
			aria-label={option.badgeTooltip ?? option.label}
			className={badgeClass}
			onClick={option.onBadgeClick}
			style={badgeStyle}
			type="button"
		>
			{badgeIcon}
		</button>
	);
	if (option.badgeTooltip === undefined) {
		return badgeButton;
	}
	return (
		<Tooltip content={option.badgeTooltip} side="top">
			{badgeButton}
		</Tooltip>
	);
}
