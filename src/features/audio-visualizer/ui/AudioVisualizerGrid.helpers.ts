import type { Coordinate } from "../lib/use-grid-animator";

export function isSpeakingCellHighlighted(
	index: number,
	columnCount: number,
	rowCount: number,
	volumeBands: number[],
): boolean {
	const y = Math.floor(index / columnCount);
	const rowMidPoint = Math.floor(rowCount / 2);
	const volumeChunks = 1 / (rowMidPoint + 1);
	const distanceToMid = Math.abs(rowMidPoint - y);
	const threshold = distanceToMid * volumeChunks;
	return (volumeBands[index % columnCount] ?? 0) >= threshold;
}

export function isCoordinateHighlighted(
	index: number,
	columnCount: number,
	highlightedCoordinate: Coordinate,
): boolean {
	return (
		highlightedCoordinate.x === index % columnCount &&
		highlightedCoordinate.y === Math.floor(index / columnCount)
	);
}

export function resolveTransitionDuration(
	interval: number,
	isHighlighted: boolean,
): number {
	return interval / (isHighlighted ? 1000 : 100);
}
