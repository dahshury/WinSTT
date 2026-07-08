import {
	Brain01Icon,
	SignalFull02Icon,
	SignalLow02Icon,
	SignalMedium02Icon,
	SignalNo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { OllamaThinkingMode } from "@/entities/llm-catalog";
import { cn } from "@/shared/lib/cn";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import type { OllamaThinkingEffort } from "./types";

type ThinkingToggle = "off" | "on";
type ThinkingLevel = "low" | "medium" | "high";

// Only On/Off is meaningful for hybrid thinking models — Low/Medium/High are
// identical on the wire (all send `think:true`), so collapsing them prevents a
// misleading "pick a level" affordance that does nothing.
const THINKING_TOGGLE_OPTIONS: readonly SwitcherOption<ThinkingToggle>[] = [
	{ value: "off", label: "Off", icon: SignalNo02Icon },
	{ value: "on", label: "On", icon: SignalFull02Icon },
];

// GPT-OSS levels: NO "Off" — the model cannot stop reasoning (`think:false`
// still yields a DEFAULT-length ~2k-char trace; measured ~3.4× slower than
// "low"). The backend maps a stored `off` to `"low"` on the wire, so the UI
// shows Low selected for it.
const THINKING_LEVEL_OPTIONS: readonly SwitcherOption<ThinkingLevel>[] = [
	{ value: "low", label: "Low", icon: SignalLow02Icon },
	{ value: "medium", label: "Medium", icon: SignalMedium02Icon },
	{ value: "high", label: "High", icon: SignalFull02Icon },
];

function levelValueOf(effort: OllamaThinkingEffort): ThinkingLevel {
	return effort === "off" ? "low" : effort;
}

// Kept out of JSX text so it reads as a value (this settings surface uses
// hardcoded English via props, matching the sibling "Thinking effort" labels).
const ALWAYS_ON_LABEL = "Always on";

function toggleValueOf(effort: OllamaThinkingEffort): ThinkingToggle {
	return effort === "off" ? "off" : "on";
}

/** Map the On/Off toggle back onto the shared effort setting. "On" preserves an
 *  existing level (so a GPT-OSS level survives a hybrid round-trip) and defaults
 *  a fresh enable to `medium`; the wire flag is `think:true` either way. */
function applyToggle(
	next: ThinkingToggle,
	current: OllamaThinkingEffort,
): OllamaThinkingEffort {
	if (next === "off") {
		return "off";
	}
	return current === "off" ? "medium" : current;
}

/**
 * Renders the right thinking control for an Ollama model's {@link
 * OllamaThinkingMode}:
 *   - `levels`    → Low/Medium/High (GPT-OSS only — it can't stop reasoning,
 *                   so there is deliberately NO "Off"; a stored `off` renders
 *                   as Low, matching the backend's off→"low" wire mapping).
 *   - `toggle`    → a two-state On/Off switch (hybrid models).
 *   - `always-on` → a read-only "Always on" indicator (dedicated reasoning
 *                   models, which can't be turned off).
 *   - `none`      → nothing.
 */
export function OllamaThinkingControl({
	dense,
	mode,
	onChange,
	value,
}: {
	dense?: boolean;
	mode: OllamaThinkingMode;
	onChange: (value: OllamaThinkingEffort) => void;
	value: OllamaThinkingEffort;
}) {
	if (mode === "none") {
		return null;
	}
	if (mode === "always-on") {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-foreground-muted text-xs"
				data-slot="ollama-thinking-always-on"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3.5"
					icon={Brain01Icon}
				/>
				{ALWAYS_ON_LABEL}
			</span>
		);
	}
	if (mode === "levels") {
		return (
			<fieldset
				aria-label="Thinking effort"
				className={cn("m-0 w-full min-w-0 border-0 p-0")}
				data-slot="ollama-thinking-levels"
			>
				<Switcher
					fullWidth={!dense}
					onChange={onChange}
					options={THINKING_LEVEL_OPTIONS}
					value={levelValueOf(value)}
				/>
			</fieldset>
		);
	}
	return (
		<fieldset
			aria-label="Thinking"
			className={cn("m-0 w-full min-w-0 border-0 p-0")}
			data-slot="ollama-thinking-toggle"
		>
			<Switcher
				fullWidth={!dense}
				onChange={(next) => onChange(applyToggle(next, value))}
				options={THINKING_TOGGLE_OPTIONS}
				value={toggleValueOf(value)}
			/>
		</fieldset>
	);
}
