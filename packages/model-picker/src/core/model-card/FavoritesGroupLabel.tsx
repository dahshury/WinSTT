"use client";

import { Combobox } from "@base-ui/react/combobox";
import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FAVORITES_GROUP_VALUE } from "../favorites";
import { GROUP_HEADER_CLASSES } from "./card-constants";

/**
 * Sticky header for the synthetic "Favorites" group — shared by every picker so
 * the favourites section docks identically while scrolling. Same chrome as a
 * maker/engine group header but star-iconed + maker-agnostic; it carries
 * `data-rail-section="favorites"` so the rail tile's click-to-jump and the
 * scroll-spy both target it like any other group.
 */
export function FavoritesGroupLabel({ count, noun = "model" }: { count: number; noun?: string }) {
	return (
		<Combobox.GroupLabel className={GROUP_HEADER_CLASSES} data-rail-section={FAVORITES_GROUP_VALUE}>
			<span className="flex size-4 items-center justify-center rounded bg-amber-400/[0.12] text-amber-400">
				<HugeiconsIcon className="size-3 fill-amber-400" icon={StarIcon} />
			</span>
			<span className="font-semibold text-[10px] text-foreground-muted uppercase tracking-[0.12em]">
				Favorites
			</span>
			<span className="text-[10px] text-foreground-dim">
				· {count === 1 ? `1 ${noun}` : `${count} ${noun}s`}
			</span>
		</Combobox.GroupLabel>
	);
}
