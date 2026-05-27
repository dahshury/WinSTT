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
				// Compact horizontal drop target: dashed border keeps the "drop here"
				// affordance, but the row collapses to a single line so it doesn't
				// dwarf the row list above. Title + description stack tightly on the
				// left of the action button.
				"relative m-2 flex items-center gap-2.5 rounded-md border-2 border-divider-strong border-dashed bg-surface-2/70 px-2.5 py-2 transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out",
				dragOver
					? "scale-[1.005] border-accent/80 bg-accent/8 shadow-[0_0_0_4px] shadow-accent/15"
					: ""
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex size-7 shrink-0 items-center justify-center rounded-full ring-1 transition-colors duration-200",
					dragOver
						? "bg-accent/20 text-accent ring-accent/40"
						: "bg-surface-3 text-foreground-dim ring-divider"
				)}
			>
				<HugeiconsIcon icon={MusicNote01Icon} size={14} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-body-sm text-foreground">{title}</span>
				<span className="truncate text-foreground-dim text-xs-tight leading-tight">
					{description}
				</span>
			</div>
			<Button
				aria-label={addLabel}
				className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-divider bg-surface-3 px-2.5 py-1 font-medium text-body-sm text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-surface-4 active:scale-[0.98]"
				onClick={onAdd}
			>
				<HugeiconsIcon icon={PlusSignIcon} size={12} />
				{addLabel}
			</Button>
		</div>
	);
}
