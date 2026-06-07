"use client";

import {
	SignalFull02Icon,
	SignalLow02Icon,
	SignalMedium02Icon,
	SignalNo02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { REASONING_EFFORT_OPTIONS, type ReasoningEffort } from "../config/model-selector-options";

const REASONING_EFFORT_ICONS: Record<ReasoningEffort, IconSvgElement> = {
	off: SignalNo02Icon,
	low: SignalLow02Icon,
	medium: SignalMedium02Icon,
	high: SignalFull02Icon,
};

// The exact catalog options, lifted onto the shared `Switcher` — the sliding-pill
// segmented control the rest of the LLM settings use — so every off/low/medium/high
// effort selector reads identically.
const REASONING_EFFORT_SWITCHER_OPTIONS: readonly SwitcherOption<ReasoningEffort>[] =
	REASONING_EFFORT_OPTIONS.map((option) => ({
		...option,
		icon: REASONING_EFFORT_ICONS[option.value],
	}));

export interface ReasoningEffortDropdownProps {
	/** Accessible label for the fieldset. Defaults to "Reasoning effort";
	 *  the Ollama thinking-effort usage overrides it to "Thinking effort". */
	ariaLabel?: string;
	className?: string;
	disabled?: boolean;
	/** Stretch the segmented control to fill its container (stacked layouts).
	 *  Pass `false` for tight row layouts so it hugs its content. Default true. */
	fullWidth?: boolean;
	onChange: (value: ReasoningEffort) => void;
	value: ReasoningEffort;
}

/**
 * Off / Low / Medium / High effort control — a thin wrapper over the shared
 * `Switcher` (animated active-segment pill on an elevated surface). This is the
 * single shared control for BOTH OpenRouter's reasoning effort and Ollama's
 * thinking effort, so the two read identically; only the accessible label and
 * the persisted setting differ. `off` disables reasoning/thinking entirely.
 */
export function ReasoningEffortDropdown({
	ariaLabel = "Reasoning effort",
	className,
	disabled = false,
	fullWidth = true,
	onChange,
	value,
}: ReasoningEffortDropdownProps) {
	return (
		<fieldset
			aria-label={ariaLabel}
			className={cn(
				"m-0 w-full min-w-0 border-0 p-0",
				disabled && "pointer-events-none opacity-60",
				className
			)}
			data-slot="reasoning-effort-dropdown"
		>
			<ElevatedSurface inline>
				<Switcher
					fullWidth={fullWidth}
					onChange={onChange}
					options={REASONING_EFFORT_SWITCHER_OPTIONS}
					value={value}
				/>
			</ElevatedSurface>
		</fieldset>
	);
}
