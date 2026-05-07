/** Agent states used to drive visualizer animations. */
export type AgentState =
	| "disconnected"
	| "connecting"
	| "initializing"
	| "listening"
	| "thinking"
	| "speaking";

/** Available visualizer types. */
export const VISUALIZER_TYPES = ["bar", "grid", "radial", "wave", "aura"] as const;
export type VisualizerType = (typeof VISUALIZER_TYPES)[number];

export function isVisualizerType(value: string): value is VisualizerType {
	return (VISUALIZER_TYPES as readonly string[]).includes(value);
}

/** Preset sizes for visualizer components. */
export type VisualizerSize = "icon" | "sm" | "md" | "lg" | "xl";
