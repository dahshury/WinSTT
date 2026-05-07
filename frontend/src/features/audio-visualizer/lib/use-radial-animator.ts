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

export function useRadialAnimator(state: AgentState, barCount: number, interval: number): number[] {
	const [index, setIndex] = useState(0);
	const [sequence, setSequence] = useState<number[][]>([[]]);

	useEffect(() => {
		if (state === "thinking") {
			setSequence(generateListeningSequence(barCount));
		} else if (state === "connecting" || state === "initializing") {
			setSequence(generateConnectingSequence(barCount));
		} else if (state === "listening") {
			setSequence(generateListeningSequence(barCount));
		} else if (state === "speaking") {
			setSequence([new Array(barCount).fill(0).map((_, idx) => idx)]);
		} else {
			setSequence([[]]);
		}
		setIndex(0);
	}, [state, barCount]);

	const animationFrameId = useRef<number | null>(null);
	const startTimeRef = useRef(performance.now());
	// biome-ignore lint/correctness/useExhaustiveDependencies: rAF loop intentionally depends on interval/barCount/state/sequence.length
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
	}, [interval, barCount, state, sequence.length]);

	return sequence[index % sequence.length] ?? [];
}
