import type { AgentState } from "./audio-visualizer";
import { useSequenceAnimator } from "./use-sequence-animator";

function gcd(x: number, y: number): number {
	let a = x;
	let b = y;
	while (b !== 0) {
		const t = b;
		b = a % b;
		a = t;
	}
	return a;
}

function findGcdLessThan(columns: number, max: number = columns): number {
	for (let i = max; i >= 1; i--) {
		if (gcd(columns, i) === i) {
			return i;
		}
	}
	return 1;
}

function generateConnectingSequence(columns: number): number[][] {
	const seq: number[][] = [];
	const center = Math.floor(columns / 2);
	for (let x = 0; x < columns; x++) {
		seq.push([x, (x + center) % columns]);
	}
	return seq;
}

function generateListeningSequence(columns: number): number[][] {
	const divisor =
		columns > 8
			? columns / findGcdLessThan(columns, 4)
			: findGcdLessThan(columns, 2);
	return Array.from({ length: divisor }, (_, idx) => [
		...new Array(Math.floor(columns / divisor))
			.fill(1)
			.map((_v, idx2) => idx2 * divisor + idx),
	]);
}

function generateSpeakingSequence(columns: number): number[][] {
	return [Array.from({ length: columns }, (_, idx) => idx)];
}

function generateEmptySequence(): number[][] {
	return [[]];
}

// Dispatch table replaces an if/else chain so buildSequence stays at CC=1.
const SEQUENCE_BUILDERS: Record<AgentState, (columns: number) => number[][]> = {
	speaking: generateSpeakingSequence,
	listening: generateListeningSequence,
	thinking: generateListeningSequence,
	connecting: generateConnectingSequence,
	initializing: generateConnectingSequence,
	disconnected: generateEmptySequence,
};

function buildSequence(state: AgentState, barCount: number): number[][] {
	return SEQUENCE_BUILDERS[state](barCount);
}

/** Test-only re-exports of internal helpers (kept out of the public barrel). */
export const __test_gcd = gcd;
export const __test_findGcdLessThan = findGcdLessThan;

export function useRadialAnimator(
	state: AgentState,
	barCount: number,
	interval: number,
): number[] {
	return useSequenceAnimator(
		buildSequence(state, barCount),
		`${state}:${barCount}`,
		interval,
	);
}
