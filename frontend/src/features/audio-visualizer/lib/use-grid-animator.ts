import { useEffect, useState } from "react";
import type { AgentState } from "./audio-visualizer";

export interface Coordinate {
	x: number;
	y: number;
}

function generateConnectingSequence(rows: number, columns: number, radius: number): Coordinate[] {
	const seq: Coordinate[] = [];
	const centerY = Math.floor(rows / 2);
	const topLeft = {
		x: Math.max(0, centerY - radius),
		y: Math.max(0, centerY - radius),
	};
	const bottomRight = {
		x: columns - 1 - topLeft.x,
		y: Math.min(rows - 1, centerY + radius),
	};

	for (let x = topLeft.x; x <= bottomRight.x; x++) {
		seq.push({ x, y: topLeft.y });
	}
	for (let y = topLeft.y + 1; y <= bottomRight.y; y++) {
		seq.push({ x: bottomRight.x, y });
	}
	for (let x = bottomRight.x - 1; x >= topLeft.x; x--) {
		seq.push({ x, y: bottomRight.y });
	}
	for (let y = bottomRight.y - 1; y > topLeft.y; y--) {
		seq.push({ x: topLeft.x, y });
	}

	return seq;
}

function generateListeningSequence(rows: number, columns: number): Coordinate[] {
	const center = { x: Math.floor(columns / 2), y: Math.floor(rows / 2) };
	const noIndex = { x: -1, y: -1 };
	return [center, noIndex, noIndex, noIndex, noIndex, noIndex, noIndex, noIndex, noIndex];
}

function generateThinkingSequence(rows: number, columns: number): Coordinate[] {
	const seq: Coordinate[] = [];
	const y = Math.floor(rows / 2);
	for (let x = 0; x < columns; x++) {
		seq.push({ x, y });
	}
	for (let x = columns - 1; x >= 0; x--) {
		seq.push({ x, y });
	}
	return seq;
}

export function useGridAnimator(
	state: AgentState,
	rows: number,
	columns: number,
	interval: number,
	radius?: number
): Coordinate {
	const [index, setIndex] = useState(0);
	const [sequence, setSequence] = useState<Coordinate[]>(() => [
		{ x: Math.floor(columns / 2), y: Math.floor(rows / 2) },
	]);

	useEffect(() => {
		const clampedRadius = radius
			? Math.min(radius, Math.floor(Math.max(rows, columns) / 2))
			: Math.floor(Math.max(rows, columns) / 2);

		if (state === "thinking") {
			setSequence(generateThinkingSequence(rows, columns));
		} else if (state === "connecting" || state === "initializing") {
			setSequence([...generateConnectingSequence(rows, columns, clampedRadius)]);
		} else if (state === "listening") {
			setSequence(generateListeningSequence(rows, columns));
		} else {
			setSequence([{ x: Math.floor(columns / 2), y: Math.floor(rows / 2) }]);
		}
		setIndex(0);
	}, [state, rows, columns, radius]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: interval loop intentionally depends on columns/rows/state/sequence.length
	useEffect(() => {
		if (state === "speaking") {
			return;
		}

		const id = setInterval(() => {
			setIndex((prev) => prev + 1);
		}, interval);

		return () => clearInterval(id);
	}, [interval, columns, rows, state, sequence.length]);

	return (
		sequence[index % sequence.length] ?? { x: Math.floor(columns / 2), y: Math.floor(rows / 2) }
	);
}
