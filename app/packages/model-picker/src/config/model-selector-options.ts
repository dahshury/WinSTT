/**
 * Option lists for reasoning-effort and verbosity dropdowns.
 *
 * These map to OpenRouter's `reasoning.effort` and `verbosity` request
 * parameters and are surfaced only when the selected model advertises support
 * for them via its `supported_parameters` list.
 */

export type ReasoningEffort = "low" | "medium" | "high";

export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
	label: string;
	value: ReasoningEffort;
}> = [
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
