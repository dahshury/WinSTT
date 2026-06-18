import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";

// Available half-height per size variant. Mirrors the heights in
// `radialVariants` (icon 24, sm 56, md 112, lg 224, xl 448) - keep in sync.
export const RADIAL_CONTAINER_HALF: Record<VisualizerSize, number> = {
	icon: 12,
	sm: 28,
	md: 56,
	lg: 112,
	xl: 224,
};

export function resolveRadialBarCount(
	barCount: number | undefined,
	size: VisualizerSize,
): number {
	if (barCount) {
		return barCount;
	}
	return size === "icon" || size === "sm" ? 12 : 24;
}

const RADIAL_SEQUENCER_INTERVAL: Partial<Record<AgentState, number>> = {
	connecting: 500,
	listening: 500,
	initializing: 250,
	thinking: Number.POSITIVE_INFINITY,
};

export function resolveRadialSequencerInterval(state: AgentState): number {
	return RADIAL_SEQUENCER_INTERVAL[state] ?? 1000;
}

const RADIAL_DISTANCE_BY_SIZE: Partial<Record<VisualizerSize, number>> = {
	icon: 6,
	xl: 128,
	lg: 64,
	sm: 16,
};

export function resolveRadialDistance(
	radius: number | undefined,
	size: VisualizerSize,
): number {
	if (radius) {
		return radius;
	}
	return RADIAL_DISTANCE_BY_SIZE[size] ?? 32;
}

export function resolveRadialDistancePct(
	radiusPct: number | undefined,
	size: VisualizerSize,
): number | undefined {
	if (radiusPct === undefined) {
		return;
	}
	return Math.round((RADIAL_CONTAINER_HALF[size] * radiusPct) / 100);
}
