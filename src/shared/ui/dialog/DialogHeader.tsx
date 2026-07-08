import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { IconButton } from "@/shared/ui/icon-button";
import { DialogDescription, DialogTitle } from "./Dialog";

export interface DialogHeaderProps {
	className?: string;
	/** aria-label + tooltip for the close button. Required with `onClose`. */
	closeLabel?: string;
	description?: ReactNode;
	/** Leading glyph beside the title, rendered in the accent color. */
	icon?: ReactNode;
	/** Renders the standard ghost close button when provided. */
	onClose?: (() => void) | undefined;
	title: ReactNode;
	/** Extra content on the trailing edge, before the close button. */
	trailing?: ReactNode;
}

/** Shared header row for free-form modals: accent icon + title (+ optional
 *  description) on the left, an optional trailing slot and the standard ghost
 *  close button on the right. One header look for every dialog, instead of
 *  each modal hand-rolling its own icon/close styling. */
export function DialogHeader({
	className,
	closeLabel,
	description,
	icon,
	onClose,
	title,
	trailing,
}: DialogHeaderProps) {
	return (
		<div className={cn("flex items-start justify-between gap-3", className)}>
			<div className="flex min-w-0 flex-1 items-start gap-2">
				{icon ? (
					<span aria-hidden="true" className="mt-0.5 flex shrink-0 text-accent">
						{icon}
					</span>
				) : null}
				<div className="min-w-0 flex-1">
					<DialogTitle className="truncate">{title}</DialogTitle>
					{description ? (
						<DialogDescription className="mt-1">
							{description}
						</DialogDescription>
					) : null}
				</div>
			</div>
			{trailing ? (
				<div className="flex shrink-0 items-center gap-2">{trailing}</div>
			) : null}
			{onClose ? (
				<IconButton
					aria-label={closeLabel ?? "Close"}
					className="shrink-0"
					icon={<HugeiconsIcon icon={Cancel01Icon} size={14} />}
					onClick={onClose}
				/>
			) : null}
		</div>
	);
}
