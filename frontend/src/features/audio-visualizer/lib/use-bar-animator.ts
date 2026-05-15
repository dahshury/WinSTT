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

const LISTEN_STATES = new Set<AgentState>(["thinking", "listening"]);
const CONNECT_STATES = new Set<AgentState>(["connecting", "initializing"]);

function buildSequence(state: AgentState, columns: number): number[][] {
	if (state === "speaking") {
		return [new Array(columns).fill(0).map((_, idx) => idx)];
	}
	if (LISTEN_STATES.has(state)) {
		return generateListeningSequence(columns);
	}
	if (CONNECT_STATES.has(state)) {
		return [...generateConnectingSequence(columns)];
	}
	return [[]];
}

export function useBarAnimator(state: AgentState, columns: number, interval: number): number[] {
	// buildSequence returns a fresh array each call; compare on the primitive
	// inputs (state, columns) instead of the reference so we don't loop in
	// environments without React Compiler (e.g. the bun test transpiler).
	const sequence = buildSequence(state, columns);
	const [index, setIndex] = useState(0);
	const [prevInputs, setPrevInputs] = useState({ state, columns });
	if (prevInputs.state !== state || prevInputs.columns !== columns) {
		setPrevInputs({ state, columns });
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
