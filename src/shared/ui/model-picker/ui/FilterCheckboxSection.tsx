"use client";

import { FilterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import type { FilterFlagConfig } from "./filter-menu-types";
import { SectionHeader } from "./FilterSectionHeader";

export function FilterCheckboxSection<
	TFlag extends string,
	TFilters extends Record<TFlag, boolean>,
>({
	filterLabel = "Filter",
	filters,
	flags,
	isDisabled,
	onToggle,
}: {
	filterLabel?: string | undefined;
	filters: TFilters;
	flags: readonly FilterFlagConfig<TFlag>[];
	isDisabled?: ((flag: TFlag) => boolean) | undefined;
	onToggle: (flag: TFlag) => void;
}) {
	const checkedIndices = new Set<number>(
		flags.flatMap((flag, i) => (filters[flag.key] ? [i] : [])),
	);
	return (
		<div className="flex flex-col gap-1.5 p-2">
			<SectionHeader icon={FilterIcon} label={filterLabel} />
			<CheckboxGroup checkedIndices={checkedIndices}>
				{flags.map((flag, i) => (
					<CheckboxItem
						checked={filters[flag.key]}
						disabled={isDisabled?.(flag.key) ?? false}
						index={i}
						key={flag.key}
						label={flag.label}
						leading={<HugeiconsIcon className="size-4" icon={flag.icon} />}
						onToggle={() => onToggle(flag.key)}
					/>
				))}
			</CheckboxGroup>
		</div>
	);
}
