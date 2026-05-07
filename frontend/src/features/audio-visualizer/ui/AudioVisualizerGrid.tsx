"use client";

import { cva } from "class-variance-authority";
import { type ComponentProps, type CSSProperties, memo, useMemo } from "react";
import { cn } from "@/shared/lib/cn";
import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";
import { useAgentState } from "../lib/use-agent-state";
import type { Coordinate } from "../lib/use-grid-animator";
import { useGridAnimator } from "../lib/use-grid-animator";
import { useMultibandVolume } from "../lib/use-multiband-volume";

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
	index: number;
	state: AgentState;
	interval: number;
	rowCount: number;
	columnCount: number;
	volumeBands: number[];
	highlightedCoordinate: Coordinate;
	size: VisualizerSize;
}

const GridCell = memo(function GridCell({
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
		const y = Math.floor(index / columnCount);
		const rowMidPoint = Math.floor(rowCount / 2);
		const volumeChunks = 1 / (rowMidPoint + 1);
		const distanceToMid = Math.abs(rowMidPoint - y);
		const threshold = distanceToMid * volumeChunks;
		const isHighlighted = (volumeBands[index % columnCount] ?? 0) >= threshold;

		return (
			<div
				className={gridCellVariants({ size })}
				data-lk-highlighted={isHighlighted}
				data-lk-index={index}
			/>
		);
	}

	const isHighlighted =
		highlightedCoordinate.x === index % columnCount &&
		highlightedCoordinate.y === Math.floor(index / columnCount);
	const transitionDurationInSeconds = interval / (isHighlighted ? 1000 : 100);

	return (
		<div
			className={gridCellVariants({ size })}
			data-lk-highlighted={isHighlighted}
			data-lk-index={index}
			style={{ transitionDuration: `${transitionDurationInSeconds}s` }}
		/>
	);
});

export interface AudioVisualizerGridProps {
	size?: VisualizerSize;
	color?: `#${string}`;
	rowCount?: number;
	columnCount?: number;
	interval?: number;
	radius?: number;
	className?: string;
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
	const items = useMemo(
		() => new Array(columnCount * rowCount).fill(0).map((_, idx) => idx),
		[columnCount, rowCount]
	);

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
			{items.map((idx) => (
				<GridCell
					columnCount={columnCount}
					highlightedCoordinate={highlightedCoordinate}
					index={idx}
					interval={interval}
					key={idx}
					rowCount={rowCount}
					size={size ?? "md"}
					state={state}
					volumeBands={volumeBands}
				/>
			))}
		</div>
	);
}
