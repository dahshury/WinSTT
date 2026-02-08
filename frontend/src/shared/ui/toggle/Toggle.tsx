"use client";

import { Switch } from "@base-ui/react/switch";

export interface ToggleProps {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}

export function Toggle({ checked, onCheckedChange, disabled }: ToggleProps) {
	return (
		<Switch.Root
			checked={checked}
			className="relative flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-surface-tertiary p-[3px] transition-colors duration-150 ease-linear data-[checked]:bg-accent-dim"
			disabled={disabled}
			onCheckedChange={onCheckedChange}
		>
			<Switch.Thumb className="pointer-events-none size-3.5 rounded-full bg-surface-active transition-[transform,background-color] duration-150 ease-linear data-[checked]:translate-x-4 data-[checked]:bg-accent" />
		</Switch.Root>
	);
}
