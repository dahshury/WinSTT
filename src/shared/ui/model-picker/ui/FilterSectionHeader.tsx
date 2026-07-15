"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function SectionHeader({
	icon,
	label,
}: {
	icon: IconSvgElement;
	label: string;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<HugeiconsIcon
				className="size-4 shrink-0 text-foreground-muted"
				icon={icon}
			/>
			<span className="font-medium text-body-sm text-foreground">{label}</span>
		</div>
	);
}
