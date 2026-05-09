"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SelectOption } from "@/shared/ui/select";
import "./searchable-select.css";

export interface SearchableSelectProps {
	disabled?: boolean;
	onChange: (value: string) => void;
	onOpenChange?: (open: boolean) => void;
	options: readonly SelectOption[];
	placeholder?: string;
	value: string;
}

function getItemLabel(item: SelectOption | null): string {
	return item ? item.label : "";
}

export function SearchableSelect({
	options,
	value,
	onChange,
	onOpenChange,
	placeholder = "Search…",
	disabled = false,
}: SearchableSelectProps) {
	const selected = options.find((o) => o.id === value) ?? null;

	return (
		<Combobox.Root
			defaultValue={selected}
			disabled={disabled}
			items={[...options]}
			itemToStringLabel={getItemLabel}
			onOpenChange={onOpenChange}
			onValueChange={(item: SelectOption | null) => {
				if (item) {
					onChange(item.id);
				}
			}}
			value={selected}
		>
			<div className="relative flex w-full items-center">
				<Combobox.Input
					className="flex h-8 w-full items-center rounded-sm border border-border bg-surface-tertiary pr-7 pl-2.5 font-inherit text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-40"
					placeholder={placeholder}
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
									className="searchable-select-item mx-1 grid cursor-default select-none grid-cols-[12px_1fr] items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-body text-foreground leading-normal outline-none data-[highlighted]:bg-surface-hover data-[selected]:text-accent"
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
			<path d="M9.16 1.12C9.51 1.35 9.6 1.81 9.38 2.16L5.14 8.66C5.02 8.84 4.82 8.97 4.6 9C4.39 9.02 4.17 8.95 4.01 8.81L1.25 6.31C0.94 6.03 0.92 5.56 1.19 5.25C1.47 4.94 1.95 4.92 2.25 5.2L4.36 7.1L8.12 1.34C8.35 0.99 8.81 0.9 9.16 1.12Z" />
		</svg>
	);
}
