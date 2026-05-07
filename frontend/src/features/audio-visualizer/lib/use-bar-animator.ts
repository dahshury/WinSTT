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

export function useBarAnimator(state: AgentState, columns: number, interval: number): number[] {
	const [index, setIndex] = useState(0);
	const [sequence, setSequence] = useState<number[][]>([[]]);

	useEffect(() => {
		if (state === "thinking") {
			setSequence(generateListeningSequence(columns));
		} else if (state === "connecting" || state === "initializing") {
			setSequence([...generateConnectingSequence(columns)]);
		} else if (state === "listening") {
			setSequence(generateListeningSequence(columns));
		} else if (state === "speaking") {
			setSequence([new Array(columns).fill(0).map((_, idx) => idx)]);
		} else {
			setSequence([[]]);
		}
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
