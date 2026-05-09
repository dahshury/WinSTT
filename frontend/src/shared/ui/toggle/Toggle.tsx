"use client";

import { Switch } from "@base-ui/react/switch";

export interface ToggleProps {
	"aria-label"?: string;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}

export function Toggle({
	checked,
	onCheckedChange,
	disabled,
	"aria-label": ariaLabel,
}: ToggleProps) {
	return (
		<Switch.Root
			aria-label={ariaLabel}
			checked={checked}
			className="relative flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-surface-tertiary p-[3px] transition-colors duration-150 ease-linear focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface data-[checked]:bg-teal-dim motion-reduce:transition-none"
			disabled={disabled}
			onCheckedChange={onCheckedChange}
		>
			<Switch.Thumb className="pointer-events-none size-3.5 rounded-full bg-surface-active transition-[transform,background-color] duration-150 ease-linear data-[checked]:translate-x-4 data-[checked]:bg-teal motion-reduce:transition-none" />
		</Switch.Root>
	);
}
