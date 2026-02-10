"use client";

import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export interface SelectOption {
	id: string;
	label: string;
}

export interface SelectProps {
	options: readonly SelectOption[];
	value: string;
	onChange: (value: string) => void;
	"aria-label"?: string;
}

export function Select({ options, value, onChange, "aria-label": ariaLabel }: SelectProps) {
	const selectedLabel = options.find((o) => o.id === value)?.label ?? value;

	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={ariaLabel}
				className="flex h-8 w-full cursor-pointer select-none items-center justify-between rounded-sm border border-border bg-surface-tertiary px-2.5 text-[13px] text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
			>
				<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
					{selectedLabel}
				</span>
				<HugeiconsIcon className="ml-1.5 shrink-0" icon={ArrowDown01Icon} size={14} />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="z-[200] outline-none" sideOffset={4}>
					<Menu.Popup className="select-popup max-h-60 min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm border border-border bg-surface-elevated py-1 shadow-md transition-[transform,opacity] duration-150 ease-out">
						<Menu.RadioGroup onValueChange={(v) => onChange(v as string)} value={value}>
							{options.map((opt) => (
								<Menu.RadioItem
									className="mx-1 flex cursor-default select-none items-center rounded-xs px-2.5 py-[7px] text-[13px] text-foreground leading-normal outline-none data-[highlighted]:bg-surface-hover data-[checked]:text-accent"
									closeOnClick
									key={opt.id}
									value={opt.id}
								>
									{opt.label}
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
