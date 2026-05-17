"use client";

import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { InfoTooltip } from "@/shared/ui/info-tooltip";

export type FormControlLayout = "stacked" | "row";

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
	/**
	 * "stacked" (default) — label/caption above, control below at full width.
	 *   Best for wide controls: pickers, multi-row selectors, checkbox groups.
	 * "row" — label/caption on the left, control on the right of the same row.
	 *   Best for tight controls: a single toggle, a small number stepper, a
	 *   switcher with 2–3 options.
	 */
	layout?: FormControlLayout;
	/** Help text shown in an info-icon tooltip next to the label */
	tooltip?: string;
}

function Header({
	label,
	labelAddon,
	tooltip,
}: {
	label?: string;
	labelAddon?: ReactNode;
	tooltip?: string;
}) {
	if (!label) {
		return null;
	}
	return (
		<div className="flex items-center gap-1.5">
			<Field.Label className="font-medium text-body text-foreground leading-tight">
				{label}
			</Field.Label>
			{labelAddon ? <span className="flex items-center">{labelAddon}</span> : null}
			{tooltip ? <InfoTooltip content={tooltip} /> : null}
		</div>
	);
}

function Caption({ caption }: { caption?: string }) {
	if (!caption) {
		return null;
	}
	return (
		<Field.Description className="text-body-sm text-foreground-muted leading-snug">
			{caption}
		</Field.Description>
	);
}

function ErrorMessage({ error }: { error?: string }) {
	if (!error) {
		return null;
	}
	return (
		<div aria-live="assertive" className="text-error text-xs-tight leading-[14px]" role="alert">
			{error}
		</div>
	);
}

export function FormControl({
	label,
	caption,
	className,
	error,
	tooltip,
	disabled,
	labelAddon,
	layout = "stacked",
	children,
}: FormControlProps) {
	const hasChildren = children !== undefined;
	const controlBox = hasChildren ? (
		<div className={disabled ? "pointer-events-none" : undefined}>{children}</div>
	) : null;

	if (layout === "row") {
		return (
			<Field.Root
				className={cn(
					"flex items-center gap-4 py-3",
					disabled && "cursor-not-allowed opacity-40",
					className
				)}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<Header label={label} labelAddon={labelAddon} tooltip={tooltip} />
					<Caption caption={caption} />
					<ErrorMessage error={error} />
				</div>
				{controlBox ? <div className="shrink-0">{controlBox}</div> : null}
			</Field.Root>
		);
	}

	return (
		<Field.Root
			className={cn(
				"flex flex-col gap-1.5 py-3",
				disabled && "cursor-not-allowed opacity-40",
				className
			)}
		>
			<Header label={label} labelAddon={labelAddon} tooltip={tooltip} />
			<Caption caption={caption} />
			{controlBox ? <div className="mt-1">{controlBox}</div> : null}
			<ErrorMessage error={error} />
		</Field.Root>
	);
}
