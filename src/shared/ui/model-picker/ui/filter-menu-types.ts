import type { IconSvgElement } from "@hugeicons/react";

/**
 * One boolean catalog predicate in a filter menu's "Filters" view. Every picker
 * describes its flags the same way; only the keys, labels and icons differ.
 */
export interface FilterFlagConfig<TFlag extends string> {
	icon: IconSvgElement;
	key: TFlag;
	label: string;
}
