"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { cn } from "@/shared/lib/cn";

export interface SwitcherOption<T extends string = string> {
	value: T;
	label: string;
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
						"px-3 py-1 font-medium text-[12px] outline-none transition-colors first:rounded-l-xs last:rounded-r-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
						"data-[pressed]:bg-accent data-[pressed]:text-white",
						"not-data-[pressed]:bg-surface-tertiary not-data-[pressed]:text-foreground-dim not-data-[pressed]:hover:text-foreground"
					)}
					key={opt.value}
					value={opt.value}
				>
					{opt.label}
				</Toggle>
			))}
		</ToggleGroup>
	);
}
