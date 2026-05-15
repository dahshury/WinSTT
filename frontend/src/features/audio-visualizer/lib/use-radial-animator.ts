import { useEffect, useRef, useState } from "react";
import type { AgentState } from "./audio-visualizer";

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
	const divisor = columns > 8 ? columns / findGcdLessThan(columns, 4) : findGcdLessThan(columns, 2);
	return Array.from({ length: divisor }, (_, idx) => [
		...new Array(Math.floor(columns / divisor)).fill(1).map((_v, idx2) => idx2 * divisor + idx),
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

function pickFrame(sequence: number[][], index: number): number[] {
	return sequence[index % sequence.length] ?? [];
}

function inputsChanged(
	prev: { state: AgentState; barCount: number },
	state: AgentState,
	barCount: number
): boolean {
	return prev.state !== state || prev.barCount !== barCount;
}

export function useRadialAnimator(state: AgentState, barCount: number, interval: number): number[] {
	// buildSequence returns a fresh array each call; compare on the primitive
	// inputs (state, barCount) instead of the reference so we don't loop in
	// environments without React Compiler (e.g. the bun test transpiler).
	const sequence = buildSequence(state, barCount);
	const [index, setIndex] = useState(0);
	const [prevInputs, setPrevInputs] = useState({ state, barCount });
	if (inputsChanged(prevInputs, state, barCount)) {
		setPrevInputs({ state, barCount });
		setIndex(0);
	}

	const animationFrameId = useRef<number | null>(null);
	const startTimeRef = useRef(performance.now());
	useEffect(() => {
		// Sequence length ≤ 1 means cycling the index changes nothing — that
		// covers "disconnected" (empty) and "speaking" (all dots highlit).
		// "thinking" uses an infinite interval (handled by CSS animate-spin
		// instead). Skip rAF entirely so idle visualizers don't burn 60 fps
		// of CPU per open BrowserWindow.
		if (sequence.length <= 1 || !Number.isFinite(interval)) {
			return;
		}
		startTimeRef.current = performance.now();

		const animate = (time: DOMHighResTimeStamp) => {
			if (time - startTimeRef.current >= interval) {
				setIndex((prev) => prev + 1);
				startTimeRef.current = time;
			}
			animationFrameId.current = requestAnimationFrame(animate);
		};

		animationFrameId.current = requestAnimationFrame(animate);
		return () => {
			if (animationFrameId.current !== null) {
				cancelAnimationFrame(animationFrameId.current);
			}
		};
	}, [interval, sequence]);

	return pickFrame(sequence, index);
}
