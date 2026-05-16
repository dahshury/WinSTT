"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties } from "react";
import { cn } from "@/shared/lib/cn";

export interface SwitcherOption<T extends string = string> {
	/** Optional per-option accent color (hex). When set, the label uses this
	 * color in the unpressed state and the option's background fills with it
	 * when pressed. */
	color?: string;
	/** When true the option is dimmed and cannot be selected */
	disabled?: boolean;
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

type SwitcherCssVars = CSSProperties & { "--switcher-color"?: string };

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
			{options.map((opt) => {
				const colored = opt.color !== undefined;
				const style: SwitcherCssVars | undefined = colored
					? { "--switcher-color": opt.color }
					: undefined;
				return (
					<Toggle
						className={cn(
							"inline-flex items-center gap-1.5 px-3 py-1 font-medium text-body-sm outline-none transition-colors first:rounded-l-xs last:rounded-r-xs focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
							colored
								? "data-[pressed]:bg-[var(--switcher-color)] data-[pressed]:text-surface"
								: "data-[pressed]:bg-accent data-[pressed]:text-white",
							colored
								? "not-data-[pressed]:bg-surface-tertiary not-data-[pressed]:text-[var(--switcher-color)] not-data-[pressed]:hover:brightness-110"
								: "not-data-[pressed]:bg-surface-tertiary not-data-[pressed]:text-foreground-dim not-data-[pressed]:hover:text-foreground",
							opt.disabled && "cursor-not-allowed opacity-40 hover:brightness-100",
							fullWidth && "flex-1 justify-center"
						)}
						disabled={opt.disabled}
						key={opt.value}
						style={style}
						value={opt.value}
					>
						{opt.icon && (
							<HugeiconsIcon aria-hidden="true" className="shrink-0" icon={opt.icon} size={13} />
						)}
						<span className="whitespace-nowrap">{opt.label}</span>
					</Toggle>
				);
			})}
		</ToggleGroup>
	);
}
