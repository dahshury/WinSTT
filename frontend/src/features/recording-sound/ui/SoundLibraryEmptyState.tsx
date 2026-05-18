"use client";

import { MusicNote01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

interface SoundLibraryEmptyStateProps {
	addLabel: string;
	description: string;
	dragOver: boolean;
	onAdd: () => void;
	title: string;
}

export function SoundLibraryEmptyState({
	dragOver,
	title,
	description,
	addLabel,
	onAdd,
}: SoundLibraryEmptyStateProps): ReactNode {
	return (
		<div
			className={cn(
				// The parcel is intentionally inset from the parent surface so it
				// reads as a self-contained "drop here" target, not part of the
				// row list. Dashed border + soft surface fill keeps it distinct
				// from the elevated solid surface around it.
				"relative m-2 flex flex-col items-center justify-center gap-3 rounded-md border-2 border-divider-strong border-dashed bg-surface-2/70 px-5 py-6 text-center transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out",
				dragOver
					? "scale-[1.005] border-accent/80 bg-accent/8 shadow-[0_0_0_4px] shadow-accent/15"
					: ""
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex size-10 items-center justify-center rounded-full ring-1 transition-colors duration-200",
					dragOver
						? "bg-accent/20 text-accent ring-accent/40"
						: "bg-surface-3 text-foreground-dim ring-divider"
				)}
			>
				<HugeiconsIcon icon={MusicNote01Icon} size={18} />
			</span>
			<div className="flex flex-col items-center gap-1">
				<span className="font-medium text-body text-foreground">{title}</span>
				<span className="max-w-[28ch] text-foreground-dim text-xs-tight leading-snug">
					{description}
				</span>
			</div>
			<Button
				aria-label={addLabel}
				className="mt-0.5 inline-flex items-center gap-1.5 rounded-md border border-divider bg-surface-3 px-3 py-1.5 font-medium text-body-sm text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-surface-4 active:scale-[0.98]"
				onClick={onAdd}
			>
				<HugeiconsIcon icon={PlusSignIcon} size={13} />
				{addLabel}
			</Button>
		</div>
	);
}
