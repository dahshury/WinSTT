"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { Tooltip } from "@/shared/ui/tooltip";

export interface FavoriteToggleProps {
	/** Drives the filled/amber state + the aria-pressed value. */
	isFavorited: boolean;
	/** Used for the accessible label ("Add {label} to favorites"). */
	label: string;
	/** Star / unstar. `preventDefault` + `stopPropagation` are handled here so
	 *  the click never bubbles to an enclosing `Combobox.Item`. */
	onToggle: () => void;
}

/**
 * Star toggle pinned to a card's right edge — the muted-amber favourites
 * vocabulary, shared across every picker so the gesture reads identically.
 * Active = muted amber-400 fill; idle = neutral foreground-muted at opacity-55.
 */
export function FavoriteToggle({
	isFavorited,
	label,
	onToggle,
}: FavoriteToggleProps) {
	return (
		<Tooltip
			content={isFavorited ? "Remove from Favorites" : "Add to Favorites"}
			side="top"
		>
			<BaseButton
				aria-label={
					isFavorited
						? `Remove ${label} from favorites`
						: `Add ${label} to favorites`
				}
				aria-pressed={isFavorited}
				className={cn(
					"inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
					"motion-reduce:transition-none",
					isFavorited
						? "text-favorite hover:bg-favorite/15"
						: "text-foreground-muted opacity-55 hover:bg-foreground/[0.08] hover:text-foreground hover:opacity-100",
				)}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					onToggle();
				}}
				type="button"
			>
				<HugeiconsIcon
					className={cn("size-3.5", isFavorited && "fill-favorite")}
					icon={StarIcon}
				/>
			</BaseButton>
		</Tooltip>
	);
}
