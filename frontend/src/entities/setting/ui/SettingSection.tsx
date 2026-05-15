"use client";

import { Separator } from "@base-ui/react/separator";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	children: ReactNode;
	/** Optional leading icon shown before the title */
	icon?: IconSvgElement;
	onToggle?: (checked: boolean) => void;
	title: string;
	toggleDisabled?: boolean;
	/** When provided, renders a toggle switch inline with the section title. */
	toggled?: boolean;
}

export function SettingSection({
	title,
	children,
	icon,
	toggled,
	onToggle,
	toggleDisabled,
}: SettingSectionProps) {
	const hasToggle = onToggle !== undefined;
	const isDisabled = hasToggle && !toggled;

	return (
		<div>
			<div className="mb-2 flex items-center gap-2 px-1">
				{icon && (
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0 text-purple"
						icon={icon}
						size={13}
					/>
				)}
				<h3 className="font-mono font-semibold text-purple text-xs-tight uppercase tracking-[0.1em]">
					{title}
				</h3>
				{hasToggle && (
					<Toggle
						aria-label={`Toggle ${title}`}
						checked={toggled ?? false}
						disabled={toggleDisabled}
						onCheckedChange={onToggle}
					/>
				)}
				<Separator className="h-px flex-1 bg-border" />
			</div>
			<div
				className={`rounded-lg border border-border bg-surface-secondary px-5 py-4 transition-opacity duration-150 ${isDisabled ? "pointer-events-none opacity-40" : ""}`}
			>
				{children}
			</div>
		</div>
	);
}
