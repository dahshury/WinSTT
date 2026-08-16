import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { IconButton } from "@/shared/ui/icon-button";
import { DialogDescription, DialogTitle } from "./Dialog";

export interface DialogHeaderProps {
	className?: string;
	/** aria-label + tooltip for the close button. Required with `onClose`. */
	closeLabel?: string;
	description?: ReactNode;
	/** Leading glyph beside the title. Rendered inside a small elevated tile so
	 *  it reads as an object rather than a stray accent-colored mark. */
	icon?: ReactNode;
	/** Renders the standard ghost close button when provided. */
	onClose?: (() => void) | undefined;
	/** Render as an attached top rail — recessed tint + hairline, edge-to-edge —
	 *  for dialogs whose body scrolls beneath it. Off for the small
	 *  confirm/opt-in dialogs, whose header is just the first row of a short
	 *  padded stack. */
	rail?: boolean;
	title: ReactNode;
	/** Extra content on the trailing edge, before the close button. */
	trailing?: ReactNode;
}

/** Shared header row for free-form modals: icon tile + title (+ optional
 *  description) on the left, an optional trailing slot and the standard ghost
 *  close button on the right. One header look for every dialog, instead of
 *  each modal hand-rolling its own icon/close styling. */
export function DialogHeader({
	className,
	closeLabel,
	description,
	icon,
	onClose,
	rail = false,
	title,
	trailing,
}: DialogHeaderProps) {
	// The tile lifts one rung off the popup plate, the same +1 step every other
	// nested control in the app takes.
	const tile = surfaceBg(Math.min(useSurface() + 1, 8));

	return (
		<div
			className={cn(
				"flex justify-between gap-3",
				// A one-line header centers everything on the title; with a
				// description the icon and close button align to the FIRST line
				// instead of floating against the middle of a two-line block.
				description ? "items-start" : "items-center",
				rail && "dialog-rail-top shrink-0 px-5 py-3.5",
				className,
			)}
		>
			<div
				className={cn(
					"flex min-w-0 flex-1 gap-2.5",
					description ? "items-start" : "items-center",
				)}
			>
				{icon ? (
					<span
						aria-hidden="true"
						className={cn(
							"flex size-7 shrink-0 items-center justify-center rounded-lg text-accent ring-1 ring-divider ring-inset",
							tile,
						)}
					>
						{icon}
					</span>
				) : null}
				<div className="min-w-0 flex-1">
					<DialogTitle className="truncate">{title}</DialogTitle>
					{/* Wraps rather than clamps: a header description is real content in
					    the short setup dialogs, and a silently cut sentence is worse
					    than a taller rail. Keep the copy to a line or two. */}
					{description ? (
						<DialogDescription className="mt-0.5 text-body-sm">
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
