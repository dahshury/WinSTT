"use client";

import { SignalFull02Icon, SignalLow02Icon, SignalMedium02Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { REASONING_EFFORT_OPTIONS, type ReasoningEffort } from "../config/model-selector-options";

const REASONING_EFFORT_ICONS: Record<ReasoningEffort, IconSvgElement> = {
	low: SignalLow02Icon,
	medium: SignalMedium02Icon,
	high: SignalFull02Icon,
};

// The exact catalog options, lifted onto the shared `Switcher` — the sliding-pill
// segmented control the rest of the LLM settings use (e.g. the Ollama
// thinking-effort picker) — so every low/medium/high selector reads identically.
const REASONING_EFFORT_SWITCHER_OPTIONS: readonly SwitcherOption<ReasoningEffort>[] =
	REASONING_EFFORT_OPTIONS.map((option) => ({
		...option,
		icon: REASONING_EFFORT_ICONS[option.value],
	}));

export interface ReasoningEffortDropdownProps {
	className?: string;
	disabled: boolean;
	onChange: (value: ReasoningEffort) => void;
	value: ReasoningEffort;
}

/**
 * Low / Medium / High reasoning-effort control — a thin wrapper over the shared
 * `Switcher` (animated active-segment pill on an elevated surface), so it matches
 * the other low/medium/high selectors across the LLM settings instead of being a
 * bespoke segmented control.
 */
export function ReasoningEffortDropdown({
	className,
	disabled,
	onChange,
	value,
}: ReasoningEffortDropdownProps) {
	return (
		<fieldset
			aria-label="Reasoning effort"
			className={cn(
				"m-0 w-full min-w-0 border-0 p-0",
				disabled && "pointer-events-none opacity-60",
				className
			)}
			data-slot="reasoning-effort-dropdown"
		>
			<ElevatedSurface inline>
				<Switcher
					fullWidth
					onChange={onChange}
					options={REASONING_EFFORT_SWITCHER_OPTIONS}
					value={value}
				/>
			</ElevatedSurface>
		</fieldset>
	);
}
