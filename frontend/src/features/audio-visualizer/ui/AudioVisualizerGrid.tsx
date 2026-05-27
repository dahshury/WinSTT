import { cva } from "class-variance-authority";
import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/shared/lib/cn";
import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";
import { useAgentState } from "../lib/use-agent-state";
import type { Coordinate } from "../lib/use-grid-animator";
import { useGridAnimator } from "../lib/use-grid-animator";
import { useMultibandVolume } from "../lib/use-multiband-volume";

export function isSpeakingCellHighlighted(
	index: number,
	columnCount: number,
	rowCount: number,
	volumeBands: number[]
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
	highlightedCoordinate: Coordinate
): boolean {
	return (
		highlightedCoordinate.x === index % columnCount &&
		highlightedCoordinate.y === Math.floor(index / columnCount)
	);
}

export function resolveTransitionDuration(interval: number, isHighlighted: boolean): number {
	return interval / (isHighlighted ? 1000 : 100);
}

const gridCellVariants = cva(
	[
		"h-1 w-1 place-self-center rounded-full bg-current/10 transition-all ease-out",
		"data-[lk-highlighted=true]:bg-current",
	],
	{
		variants: {
			size: {
				icon: "h-[2px] w-[2px]",
				sm: "h-[4px] w-[4px]",
				md: "h-[8px] w-[8px]",
				lg: "h-[12px] w-[12px]",
				xl: "h-[16px] w-[16px]",
			},
		},
		defaultVariants: { size: "md" },
	}
);

const gridContainerVariants = cva("grid", {
	variants: {
		size: {
			icon: "gap-[2px]",
			sm: "gap-[4px]",
			md: "gap-[8px]",
			lg: "gap-[12px]",
			xl: "gap-[16px]",
		},
	},
	defaultVariants: { size: "md" },
});

interface GridCellProps {
	columnCount: number;
	highlightedCoordinate: Coordinate;
	index: number;
	interval: number;
	rowCount: number;
	size: VisualizerSize;
	state: AgentState;
	volumeBands: number[];
}

function GridCell({
	index,
	state,
	interval,
	rowCount,
	columnCount,
	volumeBands,
	highlightedCoordinate,
	size,
}: GridCellProps) {
	if (state === "speaking") {
		const isHighlighted = isSpeakingCellHighlighted(index, columnCount, rowCount, volumeBands);
		return (
			<div
				className={gridCellVariants({ size })}
				data-lk-highlighted={isHighlighted}
				data-lk-index={index}
			/>
		);
	}

	const isHighlighted = isCoordinateHighlighted(index, columnCount, highlightedCoordinate);
	const transitionDurationInSeconds = resolveTransitionDuration(interval, isHighlighted);

	return (
		<div
			className={gridCellVariants({ size })}
			data-lk-highlighted={isHighlighted}
			data-lk-index={index}
			style={{ transitionDuration: `${transitionDurationInSeconds}s` }}
		/>
	);
}

export interface AudioVisualizerGridProps {
	className?: string;
	color?: `#${string}`;
	columnCount?: number;
	interval?: number;
	radius?: number;
	rowCount?: number;
	size?: VisualizerSize;
}

export function AudioVisualizerGrid({
	size = "md",
	color,
	rowCount: _rowCount = 5,
	columnCount: _columnCount = 5,
	interval = 100,
	radius,
	className,
	style,
	...props
}: AudioVisualizerGridProps & ComponentProps<"div">) {
	const state = useAgentState();
	const columnCount = _columnCount;
	const rowCount = _rowCount;
	const cells = Array.from({ length: columnCount * rowCount }, (_, position) => ({
		id: `grid-${columnCount}x${rowCount}-${position}`,
		position,
	}));

	const highlightedCoordinate = useGridAnimator(state, rowCount, columnCount, interval, radius);
	const volumeBands = useMultibandVolume(columnCount);

	return (
		<div
			className={cn(gridContainerVariants({ size }), className)}
			data-lk-state={state}
			style={
				{ ...style, gridTemplateColumns: `repeat(${columnCount}, 1fr)`, color } as CSSProperties
			}
			{...props}
		>
			{cells.map((cell) => (
				<GridCell
					columnCount={columnCount}
					highlightedCoordinate={highlightedCoordinate}
					index={cell.position}
					interval={interval}
					key={cell.id}
					rowCount={rowCount}
					size={size ?? "md"}
					state={state}
					volumeBands={volumeBands}
				/>
			))}
		</div>
	);
}
