"use client";

import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import { InfoTooltip } from "@/shared/ui/info-tooltip";

export interface FormControlProps {
	caption?: string;
	children?: ReactNode;
	/** Extra classes applied to the root, e.g. to control grid placement */
	className?: string;
	/** Visually dim the label, caption, and children */
	disabled?: boolean;
	error?: string;
	label?: string;
	/** Element rendered inline next to the label (e.g. a toggle) */
	labelAddon?: ReactNode;
	/** Help text shown in an info-icon tooltip next to the label */
	tooltip?: string;
}

export function FormControl({
	label,
	caption,
	className,
	error,
	tooltip,
	disabled,
	labelAddon,
	children,
}: FormControlProps) {
	const base = disabled ? "flex cursor-not-allowed flex-col opacity-40" : "flex flex-col";
	return (
		<Field.Root className={className ? `${base} ${className}` : base}>
			{label && (
				<div className="flex items-center gap-1">
					<Field.Label className="font-medium text-body text-foreground leading-4">
						{label}
					</Field.Label>
					{labelAddon && <span className="flex items-center">{labelAddon}</span>}
					{tooltip && <InfoTooltip content={tooltip} />}
				</div>
			)}
			{caption && (
				<Field.Description className="mt-1 text-foreground-dim text-xs-tight leading-[14px]">
					{caption}
				</Field.Description>
			)}
			{children !== undefined && (
				<div className={disabled ? "pointer-events-none mt-2.5" : "mt-2.5"}>{children}</div>
			)}
			{error && (
				<div
					aria-live="assertive"
					className="mt-1 text-error text-xs-tight leading-[14px]"
					role="alert"
				>
					{error}
				</div>
			)}
		</Field.Root>
	);
}
