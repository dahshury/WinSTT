"use client";

import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSubsectionProps {
	/** One-line description rendered under the title. */
	caption?: string;
	children: ReactNode;
	/** Optional leading icon shown before the title. */
	icon?: IconSvgElement;
	onToggle?: (checked: boolean) => void;
	title: string;
	toggleDisabled?: boolean;
	/** When provided, renders a toggle switch inline with the title. */
	toggled?: boolean;
}

/**
 * Subordinate section nested *inside* a {@link SettingSection}'s content box.
 * Lighter-weight than SettingSection (no outer border/elevation) and visually
 * indented so the master ↔ sub-feature relationship reads at a glance. When
 * its own toggle is off the children dim + go non-interactive; when the
 * parent SettingSection's master toggle is off the wrapping
 * `pointer-events-none/opacity` already cascades over the whole subtree.
 */
export function SettingSubsection({
	title,
	caption,
	children,
	icon,
	toggled,
	onToggle,
	toggleDisabled,
}: SettingSubsectionProps) {
	const hasToggle = onToggle !== undefined;
	const isDisabled = hasToggle && !toggled;

	return (
		<div className="mt-4 border-border border-l-2 pl-4 first:mt-0">
			<div className="mb-1 flex items-center gap-2">
				{icon && (
					<HugeiconsIcon aria-hidden="true" className="shrink-0 text-teal" icon={icon} size={12} />
				)}
				<h4 className="font-mono font-semibold text-teal text-xs-tight uppercase tracking-[0.08em]">
					{title}
				</h4>
				{hasToggle && (
					<Toggle
						aria-label={`Toggle ${title}`}
						checked={toggled ?? false}
						disabled={toggleDisabled}
						onCheckedChange={onToggle}
					/>
				)}
			</div>
			{caption && <p className="mb-2 text-foreground-muted text-xs">{caption}</p>}
			<div
				className={`transition-opacity duration-150 ${isDisabled ? "pointer-events-none opacity-40" : ""}`}
			>
				{children}
			</div>
		</div>
	);
}
