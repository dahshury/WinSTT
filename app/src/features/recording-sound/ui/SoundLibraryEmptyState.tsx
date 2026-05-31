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
	// Borderless, grayscale prompt — no dashed drop box. Drag feedback is the
	// whole card's neutral ring (see SoundLibrary); here it's just a soft neutral
	// wash so the row reads as "active target" without any accent or border.
	return (
		<div
			className={cn(
				"relative z-raised flex items-center gap-3 rounded-lg px-3 py-3 transition-colors duration-200",
				dragOver ? "bg-foreground/[0.05]" : ""
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200",
					dragOver
						? "bg-foreground/15 text-foreground"
						: "bg-foreground/[0.06] text-foreground-muted"
				)}
			>
				<HugeiconsIcon icon={MusicNote01Icon} size={15} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-body-sm text-foreground">{title}</span>
				<span className="truncate text-foreground-muted text-xs-tight leading-tight">
					{description}
				</span>
			</div>
			<Button
				aria-label={addLabel}
				className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-foreground/[0.06] px-2.5 py-1.5 font-medium text-body-sm text-foreground transition-colors duration-150 hover:bg-foreground/10 active:scale-[0.98]"
				onClick={onAdd}
			>
				<HugeiconsIcon icon={PlusSignIcon} size={12} />
				{addLabel}
			</Button>
		</div>
	);
}
