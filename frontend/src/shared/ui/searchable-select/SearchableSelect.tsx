"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SelectOption } from "@/shared/ui/select";
import "./searchable-select.css";

export interface SearchableSelectProps {
	options: readonly SelectOption[];
	value: string;
	onChange: (value: string) => void;
}

function getItemLabel(item: SelectOption | null): string {
	return item ? item.label : "";
}

export function SearchableSelect({ options, value, onChange }: SearchableSelectProps) {
	const selected = options.find((o) => o.id === value) ?? null;

	return (
		<Combobox.Root
			defaultValue={selected}
			items={options as SelectOption[]}
			itemToStringLabel={getItemLabel}
			onValueChange={(item: SelectOption | null) => {
				if (item) {
					onChange(item.id);
				}
			}}
			value={selected}
		>
			<div className="relative flex w-full items-center">
				<Combobox.Input
					className="flex h-8 w-full items-center rounded-sm border border-border bg-surface-tertiary pr-7 pl-2.5 font-inherit text-[13px] text-foreground leading-normal outline-none focus:border-accent"
					placeholder="Search…"
				/>
				<Combobox.Trigger
					aria-label="Open popup"
					className="absolute top-1/2 right-1.5 flex size-5 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent p-0 text-foreground-dim"
				>
					<HugeiconsIcon icon={ArrowDown01Icon} size={14} />
				</Combobox.Trigger>
			</div>

			<Combobox.Portal>
				<Combobox.Positioner className="z-[200] outline-none" sideOffset={4}>
					<Combobox.Popup className="searchable-select-popup max-h-60 w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm border border-border bg-surface-elevated py-1 shadow-md">
						<Combobox.Empty className="searchable-select-empty">No models found.</Combobox.Empty>
						<Combobox.List className="outline-none">
							{(item: SelectOption) => (
								<Combobox.Item
									className="searchable-select-item mx-1 grid cursor-default select-none grid-cols-[12px_1fr] items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-[13px] text-foreground leading-normal outline-none data-[highlighted]:bg-surface-hover data-[selected]:text-accent"
									key={item.id}
									value={item}
								>
									<Combobox.ItemIndicator className="col-start-1 flex items-center justify-center">
										<CheckIcon />
									</Combobox.ItemIndicator>
									<span className="col-start-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
										{item.label}
									</span>
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
}

function CheckIcon() {
	return (
		<svg
			aria-hidden="true"
			fill="currentcolor"
			height="10"
			role="img"
			viewBox="0 0 10 10"
			width="10"
		>
			<title>Selected</title>
			<path d="M9.1603 1.12218C9.50684 1.34873 9.60427 1.81354 9.37792 2.16038L5.13603 8.66012C5.01614 8.8438 4.82192 8.96576 4.60451 8.99384C4.3871 9.02194 4.1683 8.95335 4.00574 8.80615L1.24664 6.30769C0.939709 6.02975 0.916013 5.55541 1.19372 5.24822C1.47142 4.94102 1.94536 4.91731 2.2523 5.19524L4.36085 7.10461L8.12299 1.33999C8.34934 0.993152 8.81376 0.895638 9.1603 1.12218Z" />
		</svg>
	);
}
