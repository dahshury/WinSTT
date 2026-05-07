"use client";

import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import { InfoTooltip } from "@/shared/ui/info-tooltip";

export interface FormControlProps {
	label?: string;
	caption?: string;
	error?: string;
	/** Help text shown in an info-icon tooltip next to the label */
	tooltip?: string;
	/** Visually dim the label, caption, and children */
	disabled?: boolean;
	children: ReactNode;
}

export function FormControl({
	label,
	caption,
	error,
	tooltip,
	disabled,
	children,
}: FormControlProps) {
	return (
		<Field.Root
			className={disabled ? "flex cursor-not-allowed flex-col opacity-40" : "flex flex-col"}
		>
			{label && (
				<div className="flex items-center gap-1">
					<Field.Label className="font-medium text-body text-foreground leading-4">
						{label}
					</Field.Label>
					{tooltip && <InfoTooltip content={tooltip} />}
				</div>
			)}
			{caption && (
				<Field.Description className="mt-0.5 text-foreground-dim text-xs-tight leading-[14px]">
					{caption}
				</Field.Description>
			)}
			<div className={disabled ? "pointer-events-none mt-1.5" : "mt-1.5"}>{children}</div>
			{error && (
				<Field.Error
					aria-live="assertive"
					className="mt-0.5 text-error text-xs-tight leading-[14px]"
					role="alert"
				>
					{error}
				</Field.Error>
			)}
		</Field.Root>
	);
}
