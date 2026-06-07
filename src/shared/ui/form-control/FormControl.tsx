import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { InfoTooltip } from "@/shared/ui/info-tooltip";

type FormControlLayout = "stacked" | "row";

export interface FormControlProps {
	caption?: string | undefined;
	children?: ReactNode;
	/** Extra classes applied to the root, e.g. to control grid placement */
	className?: string | undefined;
	/** Visually dim the label, caption, and children */
	disabled?: boolean | undefined;
	error?: string | undefined;
	label?: string | undefined;
	/** Element rendered inline next to the label (e.g. a toggle) */
	labelAddon?: ReactNode;
	/**
	 * Element rendered at the trailing edge of the header row, AFTER the info
	 * tooltip pill (e.g. a per-setting reset button). Always visible.
	 */
	labelTrailing?: ReactNode;
	/**
	 * "stacked" (default) — label/caption above, control below at full width.
	 *   Best for wide controls: pickers, multi-row selectors, checkbox groups.
	 * "row" — label/caption on the left, control on the right of the same row.
	 *   Best for tight controls: a single toggle, a small number stepper, a
	 *   switcher with 2–3 options.
	 */
	layout?: FormControlLayout | undefined;
	/** Help text shown in an info-icon tooltip next to the label */
	tooltip?: string | undefined;
}

function Header({
	label,
	labelTrailing,
	tooltip,
}: {
	label?: string | undefined;
	labelTrailing?: ReactNode;
	tooltip?: string | undefined;
}) {
	if (!label) {
		return null;
	}
	return (
		<div className="flex items-center gap-1.5">
			<Field.Label className="font-medium text-body text-foreground leading-tight">
				{label}
			</Field.Label>
			{tooltip ? <InfoTooltip content={tooltip} /> : null}
			{labelTrailing ? (
				<span className="flex items-center">{labelTrailing}</span>
			) : null}
		</div>
	);
}

function Caption({ caption }: { caption?: string | undefined }) {
	if (!caption) {
		return null;
	}
	return (
		<Field.Description className="text-body-sm text-foreground-muted leading-snug">
			{caption}
		</Field.Description>
	);
}

function ErrorMessage({ error }: { error?: string | undefined }) {
	if (!error) {
		return null;
	}
	return (
		<div
			aria-live="assertive"
			className="text-error text-xs-tight leading-[14px]"
			role="alert"
		>
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
	labelTrailing,
	layout = "stacked",
	children,
}: FormControlProps) {
	const hasChildren = children !== undefined;
	const controlBox = hasChildren ? (
		<div className={disabled ? "pointer-events-none" : undefined}>
			{children}
		</div>
	) : null;

	// "row" — a compact control (small switcher / number stepper) sits on the
	// trailing edge of the same row as its label + caption.
	if (layout === "row") {
		return (
			<Field.Root
				className={cn(
					"flex items-center gap-4 py-3",
					disabled && "cursor-not-allowed opacity-40",
					className,
				)}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<Header
						label={label}
						labelTrailing={labelTrailing}
						tooltip={tooltip}
					/>
					<Caption caption={caption} />
					<ErrorMessage error={error} />
				</div>
				{labelAddon ? (
					<div className="flex shrink-0 items-center">{labelAddon}</div>
				) : null}
				{controlBox ? <div className="shrink-0">{controlBox}</div> : null}
			</Field.Root>
		);
	}

	// "stacked" (default) — the header puts label + caption on the left and any
	// `labelAddon` (a Toggle) on the trailing edge, so switches always sit
	// right-aligned on the setting's own row rather than crammed after the
	// label text. A wide control (`children`) flows full-width beneath. When
	// there is no body the toggle is vertically centred against the
	// label+caption block; with a body it aligns to the label row.
	return (
		<Field.Root
			className={cn(
				"flex flex-col gap-1.5 py-3",
				disabled && "cursor-not-allowed opacity-40",
				className,
			)}
		>
			<div
				className={cn(
					"flex gap-4",
					controlBox ? "items-start" : "items-center",
				)}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<Header
						label={label}
						labelTrailing={labelTrailing}
						tooltip={tooltip}
					/>
					<Caption caption={caption} />
				</div>
				{labelAddon ? (
					<div className="flex shrink-0 items-center">{labelAddon}</div>
				) : null}
			</div>
			{controlBox ? <div className="mt-1">{controlBox}</div> : null}
			<ErrorMessage error={error} />
		</Field.Root>
	);
}
