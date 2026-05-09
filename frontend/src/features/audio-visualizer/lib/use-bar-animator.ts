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

function buildSequence(state: AgentState, columns: number): number[][] {
	if (state === "thinking" || state === "listening") {
		return generateListeningSequence(columns);
	}
	if (state === "connecting" || state === "initializing") {
		return [...generateConnectingSequence(columns)];
	}
	if (state === "speaking") {
		return [new Array(columns).fill(0).map((_, idx) => idx)];
	}
	return [[]];
}

export function useBarAnimator(state: AgentState, columns: number, interval: number): number[] {
	const [index, setIndex] = useState(0);
	const [sequence, setSequence] = useState<number[][]>(() => buildSequence(state, columns));

	useEffect(() => {
		setSequence(buildSequence(state, columns));
		setIndex(0);
	}, [state, columns]);

	const animationFrameId = useRef<number | null>(null);
	const startTimeRef = useRef(performance.now());
	// biome-ignore lint/correctness/useExhaustiveDependencies: rAF loop intentionally depends on interval/columns/state/sequence.length
	useEffect(() => {
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
	}, [interval, columns, state, sequence.length]);

	return sequence[index % sequence.length] ?? [];
}
