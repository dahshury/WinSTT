"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";

export interface SwitcherOption<T extends string = string> {
	value: T;
	label: string;
	/** Optional leading icon shown before the label */
	icon?: IconSvgElement;
}

export interface SwitcherProps<T extends string = string> {
	options: readonly SwitcherOption<T>[];
	value: T;
	onChange: (value: T) => void;
}

export function Switcher<T extends string = string>({
	options,
	value,
	onChange,
}: SwitcherProps<T>) {
	return (
		<ToggleGroup
			className="inline-flex rounded-sm border border-border"
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
						"not-data-[pressed]:bg-surface-tertiary not-data-[pressed]:text-foreground-dim not-data-[pressed]:hover:text-foreground"
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
