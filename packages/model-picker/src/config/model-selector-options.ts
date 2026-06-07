/**
 * Option lists for reasoning-effort and verbosity dropdowns.
 *
 * These map to OpenRouter's `reasoning.effort` and `verbosity` request
 * parameters and are surfaced only when the selected model advertises support
 * for them via its `supported_parameters` list.
 *
 * `reasoningEffort` shares the same `off | low | medium | high` scale as the
 * Ollama thinking-effort control (both drive the shared `ReasoningEffortDropdown`).
 * `off` disables reasoning entirely — on the wire it becomes
 * `reasoning: { enabled: false }` rather than an `effort` value.
 */

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
	label: string;
	value: ReasoningEffort;
}> = [
	{ value: "off", label: "Off" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

export type Verbosity = "low" | "medium" | "high";

export const VERBOSITY_OPTIONS: ReadonlyArray<{ label: string; value: Verbosity }> = [
	{ value: "low", label: "Concise" },
	{ value: "medium", label: "Balanced" },
	{ value: "high", label: "Verbose" },
];
