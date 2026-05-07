"use client";

import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";

export interface SelectOption {
	id: string;
	label: string;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	/** Optional short badge text shown before the label (e.g. "EN", "中") */
	badge?: string;
}

export interface SelectProps {
	options: readonly SelectOption[];
	value: string;
	onChange: (value: string) => void;
	"aria-label"?: string;
}

function OptionContent({ option }: { option: SelectOption }) {
	return (
		<>
			{option.badge && (
				<span className="inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-xs border border-border bg-surface px-1 font-mono font-semibold text-[10px] text-foreground-secondary uppercase tracking-wider">
					{option.badge}
				</span>
			)}
			{option.icon && (
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={option.icon}
					size={14}
				/>
			)}
			<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
				{option.label}
			</span>
		</>
	);
}

export function Select({ options, value, onChange, "aria-label": ariaLabel }: SelectProps) {
	const selected = options.find((o) => o.id === value);
	const selectedLabel = selected?.label ?? value;

	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={ariaLabel}
				className="flex h-8 w-full cursor-pointer select-none items-center justify-between gap-1.5 rounded-sm border border-border bg-surface-tertiary px-2.5 text-body text-foreground leading-normal outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					{selected ? (
						<OptionContent option={selected} />
					) : (
						<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
							{selectedLabel}
						</span>
					)}
				</span>
				<HugeiconsIcon className="shrink-0" icon={ArrowDown01Icon} size={14} />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className="z-[200] outline-none" sideOffset={4}>
					<Menu.Popup className="select-popup max-h-60 min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm border border-border bg-surface-elevated py-1 shadow-md transition-[transform,opacity] duration-150 ease-out">
						<Menu.RadioGroup onValueChange={(v: string) => onChange(v)} value={value}>
							{options.map((opt) => (
								<Menu.RadioItem
									className="mx-1 flex cursor-default select-none items-center gap-1.5 rounded-xs px-2.5 py-[7px] text-body text-foreground leading-normal outline-none data-[highlighted]:bg-surface-hover data-[checked]:text-accent"
									closeOnClick
									key={opt.id}
									value={opt.id}
								>
									<OptionContent option={opt} />
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
