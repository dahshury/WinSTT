"use client";

import type { ReactNode } from "react";
import { Toggle } from "@/shared/ui/toggle";

export interface SettingSectionProps {
	title: string;
	children: ReactNode;
	/** When provided, renders a toggle switch inline with the section title. */
	toggled?: boolean;
	onToggle?: (checked: boolean) => void;
	toggleDisabled?: boolean;
}

export function SettingSection({
	title,
	children,
	toggled,
	onToggle,
	toggleDisabled,
}: SettingSectionProps) {
	const hasToggle = onToggle !== undefined;
	const isDisabled = hasToggle && !toggled;

	return (
		<div className="mb-4">
			<div className="mb-1.5 flex items-center gap-2 px-1">
				<h3 className="font-mono font-semibold text-[11px] text-purple uppercase tracking-[0.1em]">
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
				<div className="h-px flex-1 bg-border" />
			</div>
			<div
				className={`rounded-lg border border-border bg-surface-secondary px-3 py-1 transition-opacity duration-150 ${isDisabled ? "pointer-events-none opacity-40" : ""}`}
			>
				{children}
			</div>
		</div>
	);
}
