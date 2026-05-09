"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";

export interface SwitcherOption<T extends string = string> {
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
	label: string;
	value: T;
}

export interface SwitcherProps<T extends string = string> {
	/** Stretch the group to fill its container; each option shares space equally */
	fullWidth?: boolean;
	onChange: (value: T) => void;
	options: readonly SwitcherOption<T>[];
	value: T;
}

export function Switcher<T extends string = string>({
	options,
	value,
	onChange,
	fullWidth,
}: SwitcherProps<T>) {
	return (
		<ToggleGroup
			className={cn("rounded-sm border border-border", fullWidth ? "flex w-full" : "inline-flex")}
			onValueChange={(groupValue) => {
				const next = groupValue[0] as T | undefined;
				if (next != null) {
					onChange(next);
				}
			}}
			value={[value]}
		>
			{options.map((opt) => (
				<Toggle
					className={cn(
						"inline-flex items-center gap-1.5 px-3 py-1 font-medium text-body-sm outline-none transition-colors first:rounded-l-xs last:rounded-r-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
						"data-[pressed]:bg-accent data-[pressed]:text-white",
						"not-data-[pressed]:bg-surface-tertiary not-data-[pressed]:text-foreground-dim not-data-[pressed]:hover:text-foreground",
						fullWidth && "flex-1 justify-center"
					)}
					key={opt.value}
					value={opt.value}
				>
					{opt.icon && (
						<HugeiconsIcon aria-hidden="true" className="shrink-0" icon={opt.icon} size={13} />
					)}
					<span>{opt.label}</span>
				</Toggle>
			))}
		</ToggleGroup>
	);
}
