import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

/** Plays the transitions.dev stagger reveal once on mount (and on `key` change,
 *  which React turns into a remount). Wrap text lines as `.t-stagger-line`. */
export function StaggerReveal({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(id);
	}, []);
	return (
		<div className={cn("t-stagger", shown && "is-shown", className)}>
			{children}
		</div>
	);
}

/** A toggle chip for a preset / custom modifier (selected = accent ring). */
export function ModifierChip({
	active,
	label,
	onToggle,
}: {
	active: boolean;
	label: string;
	onToggle: () => void;
}) {
	return (
		<Button
			aria-pressed={active}
			className={cn(
				"rounded-full border px-2.5 py-1 text-xs transition-colors",
				active
					? "border-accent/60 bg-accent/15 text-foreground"
					: "border-border bg-surface-2 text-foreground-muted hover:text-foreground",
			)}
			onClick={onToggle}
			type="button"
		>
			{label}
		</Button>
	);
}

/** Muted info pill explaining why a disabled control is unavailable. */
export function PreviewInfoPill({ text }: { text: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-foreground-muted leading-snug">
			<HugeiconsIcon
				aria-hidden="true"
				className="shrink-0 text-foreground-subtle"
				icon={InformationCircleIcon}
				size={13}
			/>
			{text}
		</span>
	);
}

export function TranscriptTextarea({
	ariaLabel,
	className,
	onSelectionChange,
	onTextChange,
	placeholder,
	value,
}: {
	ariaLabel: string;
	className?: string;
	onSelectionChange: (start: number, end: number) => void;
	onTextChange: (value: string, start: number, end: number) => void;
	placeholder: string;
	value: string;
}) {
	return (
		<textarea
			aria-label={ariaLabel}
			className={cn(
				"w-full resize-none rounded-md border border-border px-2.5 py-2 text-foreground text-sm leading-snug placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-accent/60",
				className,
			)}
			dir="auto"
			onChange={(event) => {
				const {
					selectionEnd,
					selectionStart,
					value: nextValue,
				} = event.currentTarget;
				onTextChange(nextValue, selectionStart, selectionEnd);
			}}
			onSelect={(event) =>
				onSelectionChange(
					event.currentTarget.selectionStart,
					event.currentTarget.selectionEnd,
				)
			}
			placeholder={placeholder}
			value={value}
		/>
	);
}

/** A labelled, lifted section panel (the FF surface system) used for each half
 *  of the split enhance layout. */
export function SectionPanel({
	children,
	className,
	title,
}: {
	children: ReactNode;
	className?: string;
	title: string;
}) {
	return (
		<section
			className={cn(
				"flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2.5",
				className,
			)}
		>
			<div className="font-medium text-[11px] text-foreground-muted uppercase leading-none tracking-[0.08em]">
				{title}
			</div>
			{children}
		</section>
	);
}
