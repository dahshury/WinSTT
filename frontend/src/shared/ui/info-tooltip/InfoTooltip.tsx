"use client";

import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/shared/ui/button";
import { Tooltip } from "@/shared/ui/tooltip";

export interface InfoTooltipProps {
	/** The help text shown on hover/focus */
	content: string;
	/** Localized aria-label for the trigger button */
	ariaLabel?: string;
}

export function InfoTooltip({ content, ariaLabel = "More info" }: InfoTooltipProps) {
	return (
		<Tooltip content={content}>
			<Button
				aria-label={ariaLabel}
				className="rounded-full bg-transparent p-0 text-foreground-muted transition-colors hover:text-foreground-secondary"
			>
				<HugeiconsIcon aria-hidden="true" icon={InformationCircleIcon} size={13} />
			</Button>
		</Tooltip>
	);
}
