import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";

export function resolveRadialBarCount(barCount: number | undefined, size: VisualizerSize): number {
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

export function resolveRadialDistance(radius: number | undefined, size: VisualizerSize): number {
	if (radius) {
		return radius;
	}
	return RADIAL_DISTANCE_BY_SIZE[size] ?? 32;
}
