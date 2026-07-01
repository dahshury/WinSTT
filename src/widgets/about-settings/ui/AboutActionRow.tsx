import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { AboutActionButton } from "./AboutActionButton";

interface AboutActionRowProps {
	buttonLabel: string;
	/** Render the trailing button with the dim-error destructive treatment. */
	destructive?: boolean;
	disabled?: boolean | undefined;
	icon: IconSvgElement;
	iconClassName?: string | undefined;
	onClick: () => void;
	/** Optional secondary line under the title (omitted for label-only rows). */
	summary?: string | undefined;
	title: string;
}

/** One flat row in an About settings section — title (+ optional summary) on
 *  the left, a compact fixed-width action button on the right. Mirrors the
 *  FormControl "row" rhythm (`gap-4 py-3`) so rows divide cleanly. */
export function AboutActionRow({
	buttonLabel,
	destructive = false,
	disabled,
	icon,
	iconClassName,
	onClick,
	summary,
	title,
}: AboutActionRowProps): ReactNode {
	return (
		<div className="flex items-center gap-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="font-medium text-body text-foreground leading-tight">
					{title}
				</span>
				{summary !== undefined ? (
					<span className="text-body-sm text-foreground-muted leading-snug">
						{summary}
					</span>
				) : null}
			</div>
			<AboutActionButton
				icon={icon}
				onClick={onClick}
				variant={destructive ? "danger" : "neutral"}
				{...(disabled !== undefined ? { disabled } : {})}
				{...(iconClassName !== undefined ? { iconClassName } : {})}
			>
				{buttonLabel}
			</AboutActionButton>
		</div>
	);
}
