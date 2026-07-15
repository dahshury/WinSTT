import { Grid3X3Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createElement } from "react";
import type { GroupRailItem } from "./GroupRail";
import { RailIconChip } from "./GroupRail";

export const ALL_AUTHORS_RAIL_ID = "__all_authors__";

export function buildAllAuthorsRailItem(count: number): GroupRailItem {
	return {
		id: ALL_AUTHORS_RAIL_ID,
		label: "All authors",
		pinned: true,
		starrable: false,
		badge: count,
		icon: createElement(
			RailIconChip,
			null,
			createElement(HugeiconsIcon, {
				className: "size-3",
				icon: Grid3X3Icon,
			}),
		),
	};
}
