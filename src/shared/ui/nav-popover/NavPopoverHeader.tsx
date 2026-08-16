"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * The bar at the top of every view. At the root it is just a caption plus an
 * optional trailing action; one level down the caption becomes a back button,
 * which is the breadcrumb that makes the hierarchy legible without a title bar
 * per view.
 */
export function NavPopoverHeader({
	backLabel,
	onBack,
	title,
	trailing,
}: {
	/** Accessible name for the back control — defaults to "Back to {title}". */
	backLabel?: string | undefined;
	/** Omit at the root: the caption renders as plain text instead. */
	onBack?: (() => void) | undefined;
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<div className="flex min-h-8 items-center justify-between gap-2 px-2 py-1.5">
			{onBack ? (
				<BaseButton
					aria-label={backLabel ?? `Back to ${title}`}
					className={cn(
						"-mx-1 flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 outline-none transition-colors",
						"text-foreground-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent",
					)}
					data-nav-back
					onClick={onBack}
					type="button"
				>
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5 shrink-0"
						icon={ArrowLeft01Icon}
					/>
					<span className="truncate font-semibold text-xs-tight uppercase tracking-wide">
						{title}
					</span>
				</BaseButton>
			) : (
				<span className="truncate font-semibold text-foreground-muted text-xs-tight uppercase tracking-wide">
					{title}
				</span>
			)}
			{trailing ? <span className="shrink-0">{trailing}</span> : null}
		</div>
	);
}
