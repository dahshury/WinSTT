"use client";

import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { VERBOSITY_OPTIONS, type Verbosity } from "../config/model-selector-options";

// Label-only options (Concise / Balanced / Verbose) on the shared `Switcher` —
// the words carry the meaning, no icons needed.
const VERBOSITY_SWITCHER_OPTIONS: readonly SwitcherOption<Verbosity>[] = VERBOSITY_OPTIONS.map(
	(option) => ({ ...option })
);

export interface VerbosityDropdownProps {
	className?: string;
	disabled: boolean;
	onChange: (value: Verbosity) => void;
	value: Verbosity;
}

/**
 * Concise / Balanced / Verbose control — the same shared `Switcher` as
 * `ReasoningEffortDropdown`, so the two request-parameter controls read as one
 * consistent low/medium/high family.
 */
export function VerbosityDropdown({
	className,
	disabled,
	onChange,
	value,
}: VerbosityDropdownProps) {
	return (
		<fieldset
			aria-label="Verbosity"
			className={cn(
				"m-0 w-full min-w-0 border-0 p-0",
				disabled && "pointer-events-none opacity-60",
				className
			)}
			data-slot="verbosity-dropdown"
		>
			<ElevatedSurface inline>
				<Switcher
					fullWidth
					onChange={onChange}
					options={VERBOSITY_SWITCHER_OPTIONS}
					value={value}
				/>
			</ElevatedSurface>
		</fieldset>
	);
}
