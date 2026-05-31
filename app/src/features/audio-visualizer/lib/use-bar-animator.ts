import { useEffect, useRef, useState } from "react";
import type { AgentState } from "./audio-visualizer";

function generateConnectingSequence(columns: number): number[][] {
	const seq: number[][] = [];
	for (let x = 0; x < columns; x++) {
		seq.push([x, columns - 1 - x]);
	}
	return seq;
}

function generateListeningSequence(columns: number): number[][] {
	const center = Math.floor(columns / 2);
	return [[center], [-1]];
}

function generateSpeakingSequence(columns: number): number[][] {
	return [new Array(columns).fill(0).map((_, idx) => idx)];
}

// Dispatch table keeps buildSequence at CC=2 (just the `??` fallback) instead
// of a ladder of `if`s. New states only need a row here.
const SEQUENCE_BUILDERS: Partial<Record<AgentState, (columns: number) => number[][]>> = {
	speaking: generateSpeakingSequence,
	listening: generateListeningSequence,
	thinking: generateListeningSequence,
	connecting: generateConnectingSequence,
	initializing: generateConnectingSequence,
};

function buildSequence(state: AgentState, columns: number): number[][] {
	return SEQUENCE_BUILDERS[state]?.(columns) ?? [[]];
}

export function useBarAnimator(state: AgentState, columns: number, interval: number): number[] {
	// buildSequence returns a fresh array each call; compare on the primitive
	// inputs (state, columns) instead of the reference so we don't loop in
	// environments without React Compiler (e.g. the bun test transpiler).
	// Collapsing the two primitives into one key drops a `||` branch and
	// keeps CC below the CRAP threshold.
	const sequence = buildSequence(state, columns);
	const inputsKey = `${state}:${columns}`;
	const [index, setIndex] = useState(0);
	const [prevInputsKey, setPrevInputsKey] = useState(inputsKey);
	if (prevInputsKey !== inputsKey) {
		setPrevInputsKey(inputsKey);
		setIndex(0);
	}

	const animationFrameId = useRef<number | null>(null);
	const startTimeRef = useRef(performance.now());
	useEffect(() => {
		// Sequence length ≤ 1 means cycling the index changes nothing — that
		// covers "disconnected" (empty) and "speaking" (all bars highlit).
		// Skip rAF entirely so idle visualizers don't burn 60 fps of CPU per
		// open BrowserWindow.
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

	return sequence[index % sequence.length] ?? [];
}
