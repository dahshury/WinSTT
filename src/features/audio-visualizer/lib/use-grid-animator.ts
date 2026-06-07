import { useEffect, useState } from "react";
import type { AgentState } from "./audio-visualizer";

export interface Coordinate {
	x: number;
	y: number;
}

function appendTopEdge(
	seq: Coordinate[],
	topLeft: Coordinate,
	bottomRight: Coordinate,
): void {
	for (let x = topLeft.x; x <= bottomRight.x; x++) {
		seq.push({ x, y: topLeft.y });
	}
}

function appendRightEdge(
	seq: Coordinate[],
	topLeft: Coordinate,
	bottomRight: Coordinate,
): void {
	for (let y = topLeft.y + 1; y <= bottomRight.y; y++) {
		seq.push({ x: bottomRight.x, y });
	}
}

function appendBottomEdge(
	seq: Coordinate[],
	topLeft: Coordinate,
	bottomRight: Coordinate,
): void {
	for (let x = bottomRight.x - 1; x >= topLeft.x; x--) {
		seq.push({ x, y: bottomRight.y });
	}
}

function appendLeftEdge(
	seq: Coordinate[],
	topLeft: Coordinate,
	bottomRight: Coordinate,
): void {
	for (let y = bottomRight.y - 1; y > topLeft.y; y--) {
		seq.push({ x: topLeft.x, y });
	}
}

function generateConnectingSequence(
	rows: number,
	columns: number,
	radius: number,
): Coordinate[] {
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
	appendTopEdge(seq, topLeft, bottomRight);
	appendRightEdge(seq, topLeft, bottomRight);
	appendBottomEdge(seq, topLeft, bottomRight);
	appendLeftEdge(seq, topLeft, bottomRight);
	return seq;
}

function generateListeningSequence(
	rows: number,
	columns: number,
): Coordinate[] {
	const center = { x: Math.floor(columns / 2), y: Math.floor(rows / 2) };
	const noIndex = { x: -1, y: -1 };
	return [
		center,
		noIndex,
		noIndex,
		noIndex,
		noIndex,
		noIndex,
		noIndex,
		noIndex,
		noIndex,
	];
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

export function clampRadius(
	radius: number | undefined,
	rows: number,
	columns: number,
): number {
	const maxR = Math.floor(Math.max(rows, columns) / 2);
	return radius ? Math.min(radius, maxR) : maxR;
}

type GridSequenceFactory = (
	rows: number,
	columns: number,
	radius: number | undefined,
) => Coordinate[];

function generateCenterSequence(rows: number, columns: number): Coordinate[] {
	return [{ x: Math.floor(columns / 2), y: Math.floor(rows / 2) }];
}

function generateConnectingSequenceForState(
	rows: number,
	columns: number,
	radius: number | undefined,
): Coordinate[] {
	return [
		...generateConnectingSequence(
			rows,
			columns,
			clampRadius(radius, rows, columns),
		),
	];
}

const GRID_SEQUENCE_FACTORIES: Record<AgentState, GridSequenceFactory> = {
	connecting: generateConnectingSequenceForState,
	disconnected: generateCenterSequence,
	initializing: generateConnectingSequenceForState,
	listening: (rows, columns) => generateListeningSequence(rows, columns),
	speaking: generateCenterSequence,
	thinking: (rows, columns) => generateThinkingSequence(rows, columns),
};

function buildGridSequence(
	state: AgentState,
	rows: number,
	columns: number,
	radius: number | undefined,
): Coordinate[] {
	const factory = GRID_SEQUENCE_FACTORIES[state] ?? generateCenterSequence;
	return factory(rows, columns, radius);
}

interface GridAnimatorInputs {
	columns: number;
	radius: number | undefined;
	rows: number;
	state: AgentState;
}

const GRID_INPUT_KEYS: ReadonlyArray<keyof GridAnimatorInputs> = [
	"state",
	"rows",
	"columns",
	"radius",
];

export function gridInputsChanged(
	prev: GridAnimatorInputs,
	next: GridAnimatorInputs,
): boolean {
	return GRID_INPUT_KEYS.some((key) => prev[key] !== next[key]);
}

export function useGridAnimator(
	state: AgentState,
	rows: number,
	columns: number,
	interval: number,
	radius?: number,
): Coordinate {
	// buildGridSequence returns a fresh array each call; compare on primitive
	// inputs instead of the reference so we don't loop in environments without
	// React Compiler (e.g. the bun test transpiler).
	const sequence = buildGridSequence(state, rows, columns, radius);
	const [index, setIndex] = useState(0);
	const [prevInputs, setPrevInputs] = useState<GridAnimatorInputs>({
		state,
		rows,
		columns,
		radius,
	});
	if (gridInputsChanged(prevInputs, { state, rows, columns, radius })) {
		setPrevInputs({ state, rows, columns, radius });
		setIndex(0);
	}

	useEffect(() => {
		if (state === "speaking") {
			return;
		}

		const id = setInterval(() => {
			setIndex((prev) => prev + 1);
		}, interval);

		return () => clearInterval(id);
	}, [interval, state]);

	return (
		sequence[index % sequence.length] ?? {
			x: Math.floor(columns / 2),
			y: Math.floor(rows / 2),
		}
	);
}
