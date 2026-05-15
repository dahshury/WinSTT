"use client";

import { cva } from "class-variance-authority";
import { type ComponentProps, type CSSProperties, useMemo } from "react";
import { cn } from "@/shared/lib/cn";
import type { AgentState, VisualizerSize } from "../lib/audio-visualizer";
import { useAgentState } from "../lib/use-agent-state";
import { useMultibandVolume } from "../lib/use-multiband-volume";
import { useRadialAnimator } from "../lib/use-radial-animator";

const radialVariants = cva(
	[
		// `aspect-square` reserves layout width equal to the height. Without it the
		// container collapses to 0 width (children are absolute-positioned only),
		// which causes dots to render outside the layout box and get clipped by
		// `overflow-hidden` ancestors like the recording overlay pill.
		"relative flex aspect-square items-center justify-center",
		"**:data-lk-index:bg-current/10",
		"**:data-lk-index:absolute **:data-lk-index:top-1/2 **:data-lk-index:left-1/2 **:data-lk-index:origin-bottom **:data-lk-index:-translate-x-1/2",
		"**:data-lk-index:data-[lk-highlighted=true]:bg-current **:data-lk-index:rounded-full **:data-lk-index:transition-colors **:data-lk-index:duration-150 **:data-lk-index:ease-linear",
		"has-data-[lk-state=connecting]:**:data-lk-index:duration-300",
		"has-data-[lk-state=initializing]:**:data-lk-index:duration-300",
		"has-data-[lk-state=listening]:**:data-lk-index:duration-300",
		"has-data-[lk-state=thinking]:animate-spin has-data-[lk-state=thinking]:**:data-lk-index:bg-current has-data-[lk-state=thinking]:[animation-duration:5s]",
	],
	{
		variants: {
			size: {
				icon: "h-[24px] gap-[2px]",
				sm: "h-[56px] gap-[4px]",
				md: "h-[112px] gap-[8px]",
				lg: "h-[224px] gap-[16px]",
				xl: "h-[448px] gap-[32px]",
			},
		},
		defaultVariants: { size: "md" },
	}
);

export interface AudioVisualizerRadialProps {
	barCount?: number;
	className?: string;
	color?: `#${string}`;
	radius?: number;
	size?: VisualizerSize;
}

export function resolveRadialBarCount(barCount: number | undefined, size: VisualizerSize): number {
	if (barCount) {
		return barCount;
	}
	return size === "icon" || size === "sm" ? 12 : 24;
}

const RADIAL_SEQUENCER_INTERVAL: Partial<Record<AgentState, number>> = {
	connecting: 500,
	listening: 500,
	initializing: 250,
	thinking: Number.POSITIVE_INFINITY,
};

export function resolveRadialSequencerInterval(state: AgentState): number {
	return RADIAL_SEQUENCER_INTERVAL[state] ?? 1000;
}

const RADIAL_DISTANCE_BY_SIZE: Partial<Record<VisualizerSize, number>> = {
	icon: 6,
	xl: 128,
	lg: 64,
	sm: 16,
};

export function resolveRadialDistance(radius: number | undefined, size: VisualizerSize): number {
	if (radius) {
		return radius;
	}
	return RADIAL_DISTANCE_BY_SIZE[size] ?? 32;
}

export function AudioVisualizerRadial({
	size = "md",
	color,
	radius,
	barCount,
	className,
	style,
	...props
}: AudioVisualizerRadialProps & ComponentProps<"div">) {
	const state = useAgentState();

	const _barCount = useMemo(() => resolveRadialBarCount(barCount, size), [barCount, size]);

	const volumeBands = useMultibandVolume(_barCount);

	const sequencerInterval = useMemo(() => resolveRadialSequencerInterval(state), [state]);

	const distanceFromCenter = useMemo(() => resolveRadialDistance(radius, size), [size, radius]);

	const highlightedIndices = useRadialAnimator(state, _barCount, sequencerInterval);
	const bands = useMemo(
		() => (state === "speaking" ? volumeBands : new Array(_barCount).fill(0)),
		[state, volumeBands, _barCount]
	);

	const dotSize = (distanceFromCenter * Math.PI) / _barCount;

	// Available space from the radial ring out to the container edge.
	// Mirrors the heights in `radialVariants` above (icon 24, sm 56, md 112, lg 224, xl 448);
	// keep both in sync.
	const maxBarHeight = useMemo(() => {
		const containerHalf = { icon: 12, sm: 28, md: 56, lg: 112, xl: 224 }[size ?? "md"] ?? 56;
		return Math.max(0, containerHalf - distanceFromCenter);
	}, [size, distanceFromCenter]);

	const minBarHeight = Math.min(dotSize, maxBarHeight);

	return (
		<div
			className={cn(radialVariants({ size }), "relative", className)}
			data-lk-state={state}
			style={{ ...style, color } as CSSProperties}
			{...props}
		>
			{bands.map((band, idx) => {
				const angle = (idx / _barCount) * Math.PI * 2;
				return (
					<div
						className="absolute top-1/2 left-1/2 size-1 -translate-x-1/2 -translate-y-1/2"
						data-lk-state={state}
						key={`radial-${_barCount}-angle-${angle.toFixed(4)}`}
						style={{
							transformOrigin: "center",
							transform: `rotate(${angle}rad) translateY(${distanceFromCenter}px)`,
						}}
					>
						<div
							data-lk-highlighted={highlightedIndices.includes(idx)}
							data-lk-index={idx}
							style={{
								width: dotSize,
								minHeight: minBarHeight,
								height: state === "speaking" ? `${maxBarHeight * band}px` : 0,
							}}
						/>
					</div>
				);
			})}
		</div>
	);
}
