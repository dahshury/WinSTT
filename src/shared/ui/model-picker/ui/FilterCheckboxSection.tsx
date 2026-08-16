"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import type { FilterFlagConfig } from "./filter-menu-types";

/**
 * The boolean-flag view of a filter menu: one checkbox per catalog predicate.
 * Flags a picker can't evaluate are pruned by the caller before they get here,
 * and locked-on flags (e.g. "Streaming" in the realtime picker) render disabled
 * rather than hidden, so it stays visible *why* the list is narrowed.
 */
export function FilterCheckboxSection<
	TFlag extends string,
	TFilters extends Record<TFlag, boolean>,
>({
	filters,
	flags,
	isDisabled,
	onToggle,
}: {
	filters: TFilters;
	flags: readonly FilterFlagConfig<TFlag>[];
	isDisabled?: ((flag: TFlag) => boolean) | undefined;
	onToggle: (flag: TFlag) => void;
}) {
	const checkedIndices = new Set<number>(
		flags.flatMap((flag, i) => (filters[flag.key] ? [i] : [])),
	);
	return (
		<div className="flex flex-col gap-1.5 p-2 pt-1" data-nav-initial-focus>
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
