/** Agent states used to drive visualizer animations. */
export type AgentState =
	| "disconnected"
	| "connecting"
	| "initializing"
	| "listening"
	| "thinking"
	| "speaking";

/** Available visualizer types. */
export const VISUALIZER_TYPES = [
	"bar",
	"grid",
	"radial",
	"wave",
	"aura",
] as const;
export type VisualizerType = (typeof VISUALIZER_TYPES)[number];

export function isVisualizerType(value: string): value is VisualizerType {
	return (VISUALIZER_TYPES as readonly string[]).includes(value);
}

/** Preset sizes for visualizer components. */
export type VisualizerSize = "icon" | "sm" | "md" | "lg" | "xl";

/** Maps the grid idle-sweep speed (1 = slow … 10 = fast) to an interval in ms. */
export function gridSpeedToInterval(speed: number): number {
	const safe = speed > 0 ? speed : 6;
	return Math.round(600 / safe);
}

/** Raw per-shape visualizer settings (a subset of the `general` settings). */
export interface VisualizerSettingsInput {
	visualizerAuraBloom?: number;
	visualizerAuraBlur?: number;
	visualizerAuraColorShift?: number;
	visualizerAuraShape?: "circle" | "line";
	visualizerBarCount?: number;
	visualizerGridColumns?: number;
	visualizerGridRows?: number;
	visualizerGridSpeed?: number;
	visualizerRadialDotCount?: number;
	visualizerRadialRadius?: number;
	visualizerWaveColorShift?: number;
	visualizerWaveLineWidth?: number;
	visualizerWaveSmoothing?: number;
}

/** Per-shape props resolved from settings, ready to forward to each component. */
export interface VisualizerConfig {
	auraBloom: number;
	auraBlur: number;
	auraColorShift: number;
	auraShape: "circle" | "line";
	barCount: number;
	gridColumns: number;
	gridInterval: number;
	gridRows: number;
	radialDotCount: number;
	radialRadiusPct: number;
	waveBlur: number;
	waveColorShift: number;
	waveLineWidth: number;
}

const PERCENT = 100;

/**
 * Resolves raw per-shape visualizer settings into the units each component
 * expects: percent knobs (0–100) become 0–1 shader uniforms, and the grid
 * speed becomes an interval in ms. Defaults mirror `generalSettingsSchema`, so
 * a partial or missing input still yields the shipped look.
 */
export function resolveVisualizerConfig(
	input: VisualizerSettingsInput | undefined,
): VisualizerConfig {
	const s = input ?? {};
	return {
		barCount: s.visualizerBarCount ?? 9,
		radialDotCount: s.visualizerRadialDotCount ?? 24,
		radialRadiusPct: s.visualizerRadialRadius ?? 57,
		gridRows: s.visualizerGridRows ?? 5,
		gridColumns: s.visualizerGridColumns ?? 5,
		gridInterval: gridSpeedToInterval(s.visualizerGridSpeed ?? 6),
		waveLineWidth: s.visualizerWaveLineWidth ?? 2,
		waveBlur: (s.visualizerWaveSmoothing ?? 50) / PERCENT,
		waveColorShift: (s.visualizerWaveColorShift ?? 5) / PERCENT,
		auraShape: s.visualizerAuraShape ?? "circle",
		auraBlur: (s.visualizerAuraBlur ?? 20) / PERCENT,
		auraBloom: (s.visualizerAuraBloom ?? 0) / PERCENT,
		auraColorShift: (s.visualizerAuraColorShift ?? 5) / PERCENT,
	};
}
