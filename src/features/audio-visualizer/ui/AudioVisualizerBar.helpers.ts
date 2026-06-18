import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";

export function resolveBarCount(
	barCount: number | undefined,
	size: VisualizerSize,
): number {
	if (barCount) {
		return barCount;
	}
	if (size === "icon") {
		return 5;
	}
	if (size === "sm") {
		return 7;
	}
	return 9;
}

const BAR_SEQUENCER_INTERVAL: Partial<
	Record<AgentState, number | ((barCount: number) => number)>
> = {
	connecting: (barCount: number) => 2000 / barCount,
	initializing: 2000,
	listening: 500,
	thinking: 150,
};

export function resolveBarSequencerInterval(
	state: AgentState,
	barCount: number,
): number {
	const entry = BAR_SEQUENCER_INTERVAL[state];
	if (entry === undefined) {
		return 1000;
	}
	return typeof entry === "function" ? entry(barCount) : entry;
}
