import type { IconSvgElement } from "@hugeicons/react";

export interface FilterFlagConfig<TFlag extends string> {
	icon: IconSvgElement;
	key: TFlag;
	label: string;
}

/**
 * Sort + filter configuration for the shared filter menu. Bundled so every
 * picker's "Sort by" chip row is described the same way (the STT / Ollama menus
 * differ only in their keys / labels / icons, never in the chip mechanics).
 */
export interface FilterSortConfig<TSortKey extends string> {
	hint: string;
	icons: Record<TSortKey, IconSvgElement>;
	keys: readonly TSortKey[];
	labels: Record<TSortKey, string>;
	onChange: (next: TSortKey | null) => void;
	sortByLabel: string;
	value: TSortKey | null;
}
