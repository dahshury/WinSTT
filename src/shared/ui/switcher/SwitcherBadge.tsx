import { Button as BaseButton } from "@base-ui/react/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";
import type { SwitcherOption } from "./switcher-option";

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

export function SwitcherBadge<T extends string>({
	option,
	rect,
}: SwitcherBadgeProps<T>) {
	const interactive =
		option.badgeTooltip !== undefined || option.onBadgeClick !== undefined;
	const badgeClass = cn(
		"absolute z-overlay inline-flex size-4 items-center justify-center rounded-full border shadow-sm transition-colors duration-150",
		surfaceBg(Math.min(useSurface() + 1, 8)),
		interactive
			? "cursor-pointer border-warning/40 text-warning/80 hover:border-warning hover:bg-warning/10 hover:text-warning"
			: "pointer-events-none border-border text-foreground-muted",
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
		<HugeiconsIcon
			aria-hidden="true"
			className="shrink-0"
			icon={badgeIconRequired}
			size={10}
		/>
	);
	if (!interactive) {
		return (
			<span aria-hidden="true" className={badgeClass} style={badgeStyle}>
				{badgeIcon}
			</span>
		);
	}
	const badgeButton = (
		<BaseButton
			aria-label={option.badgeTooltip ?? option.label}
			className={badgeClass}
			onClick={option.onBadgeClick}
			style={badgeStyle}
			type="button"
		>
			{badgeIcon}
		</BaseButton>
	);
	if (option.badgeTooltip === undefined) {
		return badgeButton;
	}
	return (
		<Tooltip
			content={option.badgeTooltip}
			footer={option.badgeTooltipFooter}
			side="top"
		>
			{badgeButton}
		</Tooltip>
	);
}
